import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BridgeServer } from "./bridge.js";
import {
  type CommandRunner,
  HerdrCommandError,
  herdr,
  Prerequisites,
  runCommand,
  shouldInvalidatePreflight,
} from "./herdr.js";
import { createNamePool } from "./names.js";
import type {
  ChildManifest,
  Goblin,
  GoblinSettings,
  GoblinSnapshot,
  HerdrStatus,
  OwnedWorkspace,
  TerminalResult,
  ThinkingLevel,
} from "./types.js";
import { buildPiArgs, resolveModel, resolveTools, validateRuntimePaths, validateTask } from "./validation.js";

const LAUNCH_DEADLINE_MS = 60_000;
const START_BUSY_RETRY_MS = 250;
const START_BUSY_WINDOW_MS = 5_000;
const COORDINATION_MS = 3_000;
const REFRESH_CACHE_MS = 1_000;
const SHUTDOWN_BARRIER_MS = 65_000;

interface PreparedLaunch {
  readonly task: string;
  readonly launchId: string;
  readonly nonce: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly canonicalModel: string;
  readonly thinking: ThinkingLevel;
  readonly trusted: boolean;
  readonly tools: string[] | undefined;
}

export interface PrepareOptions {
  readonly task: string;
  readonly requestedModel?: string;
  readonly thinking: ThinkingLevel;
  readonly trusted: boolean;
  readonly parentModel: Model<Api> | undefined;
  readonly modelRegistry: ModelRegistry;
}

export interface RuntimeOptions {
  readonly settings: GoblinSettings;
  readonly bridgePath: string;
  readonly runtimeRoot?: string;
  readonly runner?: CommandRunner;
  readonly prerequisites?: Prerequisites;
  readonly bridgeFactory?: (manifest: ChildManifest, goblin: Goblin, runtime: GoblinRuntime) => BridgeServer;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

function immutableSnapshot(goblin: Goblin): GoblinSnapshot {
  return Object.freeze({
    name: goblin.name,
    status: goblin.status,
    turns: goblin.turns,
    tokens: Object.freeze({ ...goblin.tokens }),
    ...(goblin.output !== undefined ? { output: goblin.output } : {}),
    ...(goblin.error !== undefined ? { error: goblin.error } : {}),
    ...(goblin.activity !== undefined ? { activity: goblin.activity } : {}),
    ...(goblin.herdrStatus !== undefined ? { herdrStatus: goblin.herdrStatus } : {}),
  });
}

function internalAgentName(launchId: string): string {
  return `goblin-${launchId.replace(/-/g, "").slice(0, 24)}`;
}

function identityMatches(agent: Record<string, unknown>, workspace: OwnedWorkspace): boolean {
  return (
    agent.workspace_id === workspace.workspaceId &&
    agent.pane_id === workspace.paneId &&
    agent.name === workspace.agentName
  );
}

export class GoblinRuntime {
  readonly goblins = new Map<string, Goblin>();
  readonly ownerId = randomUUID();
  private readonly names = createNamePool();
  private readonly runner: CommandRunner;
  private readonly prerequisites: Prerequisites;
  private readonly runtimeRoot: string;
  private readonly cleanups = new Set<Promise<void>>();
  private shutdownPromise?: Promise<void>;

  constructor(private readonly options: RuntimeOptions) {
    this.runner = options.runner ?? runCommand;
    this.prerequisites = options.prerequisites ?? new Prerequisites(this.runner);
    this.runtimeRoot =
      options.runtimeRoot ?? join(process.env.TMPDIR || "/tmp", `pi-goblins-${this.ownerId.slice(0, 8)}`);
  }

  async prepare(options: PrepareOptions): Promise<PreparedLaunch> {
    await this.prerequisites.check();
    validateTask(options.task);
    const launchId = randomUUID();
    const runtimeDir = join(this.runtimeRoot, launchId);
    const socketPath = join(runtimeDir, "bridge.sock");
    validateRuntimePaths(runtimeDir, socketPath);
    const { canonical } = resolveModel(
      options.requestedModel,
      options.parentModel,
      options.modelRegistry.getAvailable(),
      this.options.settings.modelPatterns,
    );
    const tools = resolveTools(this.options.settings);
    return {
      task: options.task,
      launchId,
      nonce: randomBytes(32).toString("hex"),
      runtimeDir,
      socketPath,
      canonicalModel: canonical,
      thinking: options.thinking,
      trusted: options.trusted,
      tools,
    };
  }

  summon(prepared: PreparedLaunch, cwd: string): Goblin {
    const name = this.names.allocate();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const goblin: Goblin = {
      name,
      task: prepared.task,
      launchId: prepared.launchId,
      ownerId: this.ownerId,
      nonce: prepared.nonce,
      runtimeDir: prepared.runtimeDir,
      socketPath: prepared.socketPath,
      startedAt: Date.now(),
      status: "running",
      turns: 0,
      tokens: { input: 0, output: 0 },
      done,
      resolveDone,
      launchController: new AbortController(),
    };
    this.goblins.set(name, goblin);
    goblin.launchPromise = this.launch(goblin, prepared, cwd).catch((error) => this.fail(goblin, error));
    return goblin;
  }

  private createBridge(manifest: ChildManifest, goblin: Goblin): BridgeServer {
    if (this.options.bridgeFactory) return this.options.bridgeFactory(manifest, goblin, this);
    return new BridgeServer(manifest, {
      onReady: () => {
        goblin.bridgeReady = true;
        this.readyResolvers.get(goblin.launchId)?.();
      },
      onTool: (activity) => {
        if (goblin.status === "running") goblin.activity = activity;
      },
      onTurn: (turns, tokens) => {
        if (goblin.status !== "running") return;
        goblin.turns = turns;
        goblin.tokens = { ...tokens };
      },
      onResult: (result) => this.bridgeResult(goblin, result),
      onError: (error) => {
        if (shouldInvalidatePreflight(error)) this.prerequisites.invalidate();
        if (goblin.status === "running" && !goblin.bridgeResult) this.fail(goblin, error);
      },
    });
  }

  private readonly readyResolvers = new Map<string, () => void>();

  private async launch(goblin: Goblin, prepared: PreparedLaunch, cwd: string): Promise<void> {
    const deadline = Date.now() + LAUNCH_DEADLINE_MS;
    const manifest: ChildManifest = {
      protocol: 1,
      ownerId: goblin.ownerId,
      launchId: goblin.launchId,
      nonce: goblin.nonce,
      socketPath: goblin.socketPath,
      turnLimit: this.options.settings.turnLimit,
    };
    const bridge = this.createBridge(manifest, goblin);
    goblin.cleanup = undefined;
    await mkdir(goblin.runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(join(goblin.runtimeDir, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    }).catch(async (error) => {
      await rm(goblin.runtimeDir, { recursive: true, force: true });
      throw error;
    });
    await bridge.listen(goblin.runtimeDir);
    this.bridges.set(goblin.launchId, bridge);

    const remaining = () => deadline - Date.now();
    const label = `pi-goblin-${goblin.name}-${goblin.launchId}`;
    let finishWorkspaceCreate!: () => void;
    goblin.workspaceCreateDone = new Promise<void>((resolve) => (finishWorkspaceCreate = resolve));
    let workspaceResult: Record<string, unknown>;
    try {
      workspaceResult = await this.command(
        [
          "workspace",
          "create",
          "--cwd",
          cwd,
          "--label",
          label,
          "--env",
          "PI_GOBLINS_CHILD=1",
          "--env",
          `PI_GOBLINS_MANIFEST=${join(goblin.runtimeDir, "manifest.json")}`,
          "--no-focus",
        ],
        goblin.launchController.signal,
        remaining(),
      );
    } finally {
      finishWorkspaceCreate();
    }
    const workspace = workspaceResult.workspace as Record<string, unknown> | undefined;
    const rootPane = workspaceResult.root_pane as Record<string, unknown> | undefined;
    if (
      workspaceResult.type !== "workspace_created" ||
      typeof workspace?.workspace_id !== "string" ||
      workspace.label !== label ||
      typeof rootPane?.pane_id !== "string" ||
      rootPane.workspace_id !== workspace.workspace_id
    ) {
      throw new Error("Malformed or identity-mismatched Herdr workspace creation response");
    }
    goblin.workspace = {
      workspaceId: workspace.workspace_id,
      paneId: rootPane.pane_id,
      label,
      agentName: internalAgentName(goblin.launchId),
    };

    const args = buildPiArgs(
      {
        model: prepared.canonicalModel,
        thinking: prepared.thinking,
        trusted: prepared.trusted,
        tools: prepared.tools,
      },
      this.options.bridgePath,
    );
    const busyUntil = Math.min(deadline, Date.now() + START_BUSY_WINDOW_MS);
    for (;;) {
      const left = remaining();
      if (left <= 3_000) throw new Error("Less than 3001 ms remains for Herdr interactive start");
      try {
        const started = await this.command(
          [
            "agent",
            "start",
            goblin.workspace.agentName,
            "--kind",
            "pi",
            "--pane",
            goblin.workspace.paneId,
            "--timeout",
            String(Math.floor(left)),
            "--",
            ...args,
          ],
          goblin.launchController.signal,
          left,
        );
        const agent = started.agent as Record<string, unknown> | undefined;
        if (started.type !== "agent_started" || !agent || !identityMatches(agent, goblin.workspace)) {
          throw new Error("Herdr agent start identity mismatch");
        }
        break;
      } catch (error) {
        if (!(error instanceof HerdrCommandError) || error.code !== "agent_pane_busy" || Date.now() >= busyUntil)
          throw error;
        await delay(Math.min(START_BUSY_RETRY_MS, busyUntil - Date.now()), goblin.launchController.signal);
        if (Date.now() >= busyUntil) throw error;
      }
    }

    if (!goblin.bridgeReady) {
      const ready = new Promise<void>((resolve) => {
        this.readyResolvers.set(goblin.launchId, resolve);
        if (goblin.bridgeReady) resolve();
      });
      await Promise.race([
        ready,
        delay(Math.max(0, remaining()), goblin.launchController.signal).then(() => {
          throw new Error("Timed out waiting for authenticated child readiness");
        }),
      ]);
      this.readyResolvers.delete(goblin.launchId);
    }
    if (remaining() <= 0) throw new Error("The shared launch deadline expired before prompting");

    const prompted = await this.command(
      ["agent", "prompt", goblin.workspace.agentName, goblin.task, "--wait", "--until", "idle", "--until", "done"],
      goblin.launchController.signal,
    );
    const promptAgent = prompted.agent as Record<string, unknown> | undefined;
    if (prompted.type !== "agent_prompted" || !promptAgent || !identityMatches(promptAgent, goblin.workspace)) {
      throw new Error("Herdr prompt response identity mismatch");
    }
    goblin.promptSucceeded = true;
    this.coordinate(goblin);
  }

  private readonly bridges = new Map<string, BridgeServer>();

  private async command(
    args: readonly string[],
    signal?: AbortSignal,
    timeout?: number,
  ): Promise<Record<string, unknown>> {
    try {
      return await herdr(args, { runner: this.runner, signal, ...(timeout === undefined ? {} : { timeout }) });
    } catch (error) {
      if (shouldInvalidatePreflight(error)) this.prerequisites.invalidate();
      throw error;
    }
  }

  private bridgeResult(goblin: Goblin, result: TerminalResult): void {
    if (goblin.status !== "running" || goblin.bridgeResult) return;
    goblin.bridgeResult = Object.freeze({ ...result });
    if (result.status === "truncated") this.terminalize(goblin, result);
    else this.coordinate(goblin);
  }

  private coordinate(goblin: Goblin): void {
    if (goblin.status !== "running") return;
    if (goblin.bridgeResult && goblin.promptSucceeded) {
      if (goblin.coordinationTimer) clearTimeout(goblin.coordinationTimer);
      this.terminalize(goblin, goblin.bridgeResult);
      return;
    }
    if ((goblin.bridgeResult || goblin.promptSucceeded) && !goblin.coordinationTimer) {
      goblin.coordinationTimer = setTimeout(
        () =>
          this.fail(goblin, new Error("Bridge result and Herdr prompt completion did not coordinate within 3 seconds")),
        COORDINATION_MS,
      );
    }
  }

  private fail(goblin: Goblin, error: unknown): void {
    this.terminalize(goblin, {
      status: "failed",
      output: goblin.bridgeResult?.output ?? "",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private terminalize(goblin: Goblin, result: TerminalResult | { status: "dismissed" }): boolean {
    if (goblin.status !== "running") return false;
    if (goblin.coordinationTimer) clearTimeout(goblin.coordinationTimer);
    goblin.status = result.status;
    if ("output" in result) goblin.output = result.output;
    if ("error" in result) goblin.error = result.error;
    goblin.completedAt = Date.now();
    goblin.resolveDone();
    queueMicrotask(() => this.trackCleanup(goblin));
    return true;
  }

  claim(goblin: Goblin): GoblinSnapshot | undefined {
    if (goblin.status === "running") return undefined;
    return this.collect(goblin);
  }

  private collect(goblin: Goblin): GoblinSnapshot | undefined {
    if (this.goblins.get(goblin.name) !== goblin) return undefined;
    this.goblins.delete(goblin.name);
    this.names.release(goblin.name);
    const snapshot = immutableSnapshot(goblin);
    this.trackCleanup(goblin);
    return snapshot;
  }

  dismiss(name: string): string[] {
    const targets =
      name === "all"
        ? [...this.goblins.values()]
        : [this.goblins.get(name)].filter((goblin): goblin is Goblin => Boolean(goblin));
    const dismissed: string[] = [];
    for (const goblin of targets) {
      if (goblin.status === "running") this.terminalize(goblin, { status: "dismissed" });
      if (this.collect(goblin)) dismissed.push(goblin.name);
    }
    return dismissed;
  }

  snapshots(): GoblinSnapshot[] {
    return [...this.goblins.values()].map(immutableSnapshot);
  }

  async refresh(goblin: Goblin): Promise<void> {
    if (!goblin.workspace || goblin.status !== "running") return;
    if (goblin.refreshedAt && Date.now() - goblin.refreshedAt < REFRESH_CACHE_MS) return;
    if (goblin.refreshPromise) return goblin.refreshPromise;
    goblin.refreshPromise = (async () => {
      try {
        const result = await this.command(["agent", "get", goblin.workspace?.agentName ?? ""]);
        const agent = result.agent as Record<string, unknown> | undefined;
        if (result.type !== "agent_info" || !agent || !goblin.workspace || !identityMatches(agent, goblin.workspace))
          return;
        if (["idle", "working", "blocked", "done", "unknown"].includes(String(agent.agent_status))) {
          goblin.herdrStatus = agent.agent_status as HerdrStatus;
        }
      } catch {
        // Display-only refresh never settles a goblin.
      } finally {
        goblin.refreshedAt = Date.now();
        goblin.refreshPromise = undefined;
      }
    })();
    return goblin.refreshPromise;
  }

  async refreshAll(goblins: readonly Goblin[] = [...this.goblins.values()]): Promise<void> {
    await Promise.all(goblins.map((goblin) => this.refresh(goblin)));
  }

  private trackCleanup(goblin: Goblin): void {
    const cleanup = this.cleanup(goblin);
    this.cleanups.add(cleanup);
    cleanup.finally(() => this.cleanups.delete(cleanup)).catch(() => {});
  }

  cleanup(goblin: Goblin): Promise<void> {
    if (goblin.cleanup) return goblin.cleanup;
    goblin.cleanup = (async () => {
      await goblin.workspaceCreateDone?.catch(() => {});
      goblin.launchController.abort();
      await goblin.launchPromise?.catch(() => {});
      const workspace = goblin.workspace;
      if (workspace) {
        let owned = false;
        let live = false;
        try {
          const result = await this.command(["workspace", "get", workspace.workspaceId], undefined, 3_000);
          const value = result.workspace as Record<string, unknown> | undefined;
          owned =
            result.type === "workspace_info" &&
            value?.workspace_id === workspace.workspaceId &&
            value?.label === workspace.label;
          if (owned) {
            try {
              const agentResult = await this.command(["agent", "get", workspace.agentName], undefined, 2_000);
              const agent = agentResult.agent as Record<string, unknown> | undefined;
              live = Boolean(
                agent &&
                  identityMatches(agent, workspace) &&
                  agent.agent_status !== "idle" &&
                  agent.agent_status !== "done",
              );
            } catch {}
            if (live) {
              await this.command(["agent", "send-keys", workspace.agentName, "esc"], undefined, 2_000).catch(() => {});
              await this.command(
                ["agent", "wait", workspace.agentName, "--until", "idle", "--until", "done", "--timeout", "2000"],
                undefined,
                3_000,
              ).catch(() => {});
            }
            await this.command(["workspace", "close", workspace.workspaceId], undefined, 5_000).catch(() => {});
          }
        } catch {}
      }
      await this.bridges
        .get(goblin.launchId)
        ?.close()
        .catch(() => {});
      this.bridges.delete(goblin.launchId);
      await rm(goblin.runtimeDir, { recursive: true, force: true });
    })();
    return goblin.cleanup;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      this.dismiss("all");
      const all = Promise.allSettled([...this.cleanups]);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_BARRIER_MS);
        void all.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    })();
    return this.shutdownPromise;
  }
}
