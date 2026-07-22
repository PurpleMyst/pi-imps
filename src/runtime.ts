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
  HerdrStatus,
  Imp,
  ImpSettings,
  ImpSnapshot,
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
  readonly settings: ImpSettings;
  readonly bridgePath: string;
  readonly runtimeRoot?: string;
  readonly runner?: CommandRunner;
  readonly prerequisites?: Prerequisites;
  readonly bridgeFactory?: (manifest: ChildManifest, imp: Imp, runtime: ImpRuntime) => BridgeServer;
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

function immutableSnapshot(imp: Imp): ImpSnapshot {
  return Object.freeze({
    name: imp.name,
    status: imp.status,
    turns: imp.turns,
    tokens: Object.freeze({ ...imp.tokens }),
    ...(imp.output !== undefined ? { output: imp.output } : {}),
    ...(imp.error !== undefined ? { error: imp.error } : {}),
    ...(imp.activity !== undefined ? { activity: imp.activity } : {}),
    ...(imp.herdrStatus !== undefined ? { herdrStatus: imp.herdrStatus } : {}),
  });
}

function internalAgentName(launchId: string): string {
  return `piimp-${launchId.replace(/-/g, "").slice(0, 24)}`;
}

function identityMatches(agent: Record<string, unknown>, workspace: OwnedWorkspace): boolean {
  return (
    agent.workspace_id === workspace.workspaceId &&
    agent.pane_id === workspace.paneId &&
    agent.name === workspace.agentName
  );
}

export class ImpRuntime {
  readonly imps = new Map<string, Imp>();
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
    this.runtimeRoot = options.runtimeRoot ?? join(process.env.TMPDIR || "/tmp", `pi-imps-${this.ownerId.slice(0, 8)}`);
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

  summon(prepared: PreparedLaunch, cwd: string): Imp {
    const name = this.names.allocate();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const imp: Imp = {
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
    this.imps.set(name, imp);
    imp.launchPromise = this.launch(imp, prepared, cwd).catch((error) => this.fail(imp, error));
    return imp;
  }

  private createBridge(manifest: ChildManifest, imp: Imp): BridgeServer {
    if (this.options.bridgeFactory) return this.options.bridgeFactory(manifest, imp, this);
    return new BridgeServer(manifest, {
      onReady: () => {
        imp.bridgeReady = true;
        this.readyResolvers.get(imp.launchId)?.();
      },
      onTool: (activity) => {
        if (imp.status === "running") imp.activity = activity;
      },
      onTurn: (turns, tokens) => {
        if (imp.status !== "running") return;
        imp.turns = turns;
        imp.tokens = { ...tokens };
      },
      onResult: (result) => this.bridgeResult(imp, result),
      onError: (error) => {
        if (shouldInvalidatePreflight(error)) this.prerequisites.invalidate();
        if (imp.status === "running" && !imp.bridgeResult) this.fail(imp, error);
      },
    });
  }

  private readonly readyResolvers = new Map<string, () => void>();

  private async launch(imp: Imp, prepared: PreparedLaunch, cwd: string): Promise<void> {
    const deadline = Date.now() + LAUNCH_DEADLINE_MS;
    const manifest: ChildManifest = {
      protocol: 1,
      ownerId: imp.ownerId,
      launchId: imp.launchId,
      nonce: imp.nonce,
      socketPath: imp.socketPath,
      turnLimit: this.options.settings.turnLimit,
    };
    const bridge = this.createBridge(manifest, imp);
    imp.cleanup = undefined;
    await mkdir(imp.runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(join(imp.runtimeDir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600, flag: "wx" }).catch(
      async (error) => {
        await rm(imp.runtimeDir, { recursive: true, force: true });
        throw error;
      },
    );
    await bridge.listen(imp.runtimeDir);
    this.bridges.set(imp.launchId, bridge);

    const remaining = () => deadline - Date.now();
    const label = `pi-imp-${imp.name}-${imp.launchId}`;
    let finishWorkspaceCreate!: () => void;
    imp.workspaceCreateDone = new Promise<void>((resolve) => (finishWorkspaceCreate = resolve));
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
          "PI_IMPS_CHILD=1",
          "--env",
          `PI_IMPS_MANIFEST=${join(imp.runtimeDir, "manifest.json")}`,
          "--no-focus",
        ],
        imp.launchController.signal,
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
    imp.workspace = {
      workspaceId: workspace.workspace_id,
      paneId: rootPane.pane_id,
      label,
      agentName: internalAgentName(imp.launchId),
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
            imp.workspace.agentName,
            "--kind",
            "pi",
            "--pane",
            imp.workspace.paneId,
            "--timeout",
            String(Math.floor(left)),
            "--",
            ...args,
          ],
          imp.launchController.signal,
          left,
        );
        const agent = started.agent as Record<string, unknown> | undefined;
        if (started.type !== "agent_started" || !agent || !identityMatches(agent, imp.workspace)) {
          throw new Error("Herdr agent start identity mismatch");
        }
        break;
      } catch (error) {
        if (!(error instanceof HerdrCommandError) || error.code !== "agent_pane_busy" || Date.now() >= busyUntil)
          throw error;
        await delay(Math.min(START_BUSY_RETRY_MS, busyUntil - Date.now()), imp.launchController.signal);
        if (Date.now() >= busyUntil) throw error;
      }
    }

    if (!imp.bridgeReady) {
      const ready = new Promise<void>((resolve) => {
        this.readyResolvers.set(imp.launchId, resolve);
        if (imp.bridgeReady) resolve();
      });
      await Promise.race([
        ready,
        delay(Math.max(0, remaining()), imp.launchController.signal).then(() => {
          throw new Error("Timed out waiting for authenticated child readiness");
        }),
      ]);
      this.readyResolvers.delete(imp.launchId);
    }
    if (remaining() <= 0) throw new Error("The shared launch deadline expired before prompting");

    const prompted = await this.command(
      ["agent", "prompt", imp.workspace.agentName, imp.task, "--wait", "--until", "idle", "--until", "done"],
      imp.launchController.signal,
    );
    const promptAgent = prompted.agent as Record<string, unknown> | undefined;
    if (prompted.type !== "agent_prompted" || !promptAgent || !identityMatches(promptAgent, imp.workspace)) {
      throw new Error("Herdr prompt response identity mismatch");
    }
    imp.promptSucceeded = true;
    this.coordinate(imp);
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

  private bridgeResult(imp: Imp, result: TerminalResult): void {
    if (imp.status !== "running" || imp.bridgeResult) return;
    imp.bridgeResult = Object.freeze({ ...result });
    if (result.status === "truncated") this.terminalize(imp, result);
    else this.coordinate(imp);
  }

  private coordinate(imp: Imp): void {
    if (imp.status !== "running") return;
    if (imp.bridgeResult && imp.promptSucceeded) {
      if (imp.coordinationTimer) clearTimeout(imp.coordinationTimer);
      this.terminalize(imp, imp.bridgeResult);
      return;
    }
    if ((imp.bridgeResult || imp.promptSucceeded) && !imp.coordinationTimer) {
      imp.coordinationTimer = setTimeout(
        () =>
          this.fail(imp, new Error("Bridge result and Herdr prompt completion did not coordinate within 3 seconds")),
        COORDINATION_MS,
      );
    }
  }

  private fail(imp: Imp, error: unknown): void {
    this.terminalize(imp, {
      status: "failed",
      output: imp.bridgeResult?.output ?? "",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private terminalize(imp: Imp, result: TerminalResult | { status: "dismissed" }): boolean {
    if (imp.status !== "running") return false;
    if (imp.coordinationTimer) clearTimeout(imp.coordinationTimer);
    imp.status = result.status;
    if ("output" in result) imp.output = result.output;
    if ("error" in result) imp.error = result.error;
    imp.completedAt = Date.now();
    imp.resolveDone();
    queueMicrotask(() => this.trackCleanup(imp));
    return true;
  }

  claim(imp: Imp): ImpSnapshot | undefined {
    if (imp.status === "running") return undefined;
    return this.collect(imp);
  }

  private collect(imp: Imp): ImpSnapshot | undefined {
    if (this.imps.get(imp.name) !== imp) return undefined;
    this.imps.delete(imp.name);
    this.names.release(imp.name);
    const snapshot = immutableSnapshot(imp);
    this.trackCleanup(imp);
    return snapshot;
  }

  dismiss(name: string): string[] {
    const targets =
      name === "all" ? [...this.imps.values()] : [this.imps.get(name)].filter((imp): imp is Imp => Boolean(imp));
    const dismissed: string[] = [];
    for (const imp of targets) {
      if (imp.status === "running") this.terminalize(imp, { status: "dismissed" });
      if (this.collect(imp)) dismissed.push(imp.name);
    }
    return dismissed;
  }

  snapshots(): ImpSnapshot[] {
    return [...this.imps.values()].map(immutableSnapshot);
  }

  async refresh(imp: Imp): Promise<void> {
    if (!imp.workspace || imp.status !== "running") return;
    if (imp.refreshedAt && Date.now() - imp.refreshedAt < REFRESH_CACHE_MS) return;
    if (imp.refreshPromise) return imp.refreshPromise;
    imp.refreshPromise = (async () => {
      try {
        const result = await this.command(["agent", "get", imp.workspace?.agentName ?? ""]);
        const agent = result.agent as Record<string, unknown> | undefined;
        if (result.type !== "agent_info" || !agent || !imp.workspace || !identityMatches(agent, imp.workspace)) return;
        if (["idle", "working", "blocked", "done", "unknown"].includes(String(agent.agent_status))) {
          imp.herdrStatus = agent.agent_status as HerdrStatus;
        }
      } catch {
        // Display-only refresh never settles an imp.
      } finally {
        imp.refreshedAt = Date.now();
        imp.refreshPromise = undefined;
      }
    })();
    return imp.refreshPromise;
  }

  async refreshAll(imps: readonly Imp[] = [...this.imps.values()]): Promise<void> {
    await Promise.all(imps.map((imp) => this.refresh(imp)));
  }

  private trackCleanup(imp: Imp): void {
    const cleanup = this.cleanup(imp);
    this.cleanups.add(cleanup);
    cleanup.finally(() => this.cleanups.delete(cleanup)).catch(() => {});
  }

  cleanup(imp: Imp): Promise<void> {
    if (imp.cleanup) return imp.cleanup;
    imp.cleanup = (async () => {
      await imp.workspaceCreateDone?.catch(() => {});
      imp.launchController.abort();
      await imp.launchPromise?.catch(() => {});
      const workspace = imp.workspace;
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
        .get(imp.launchId)
        ?.close()
        .catch(() => {});
      this.bridges.delete(imp.launchId);
      await rm(imp.runtimeDir, { recursive: true, force: true });
    })();
    return imp.cleanup;
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
