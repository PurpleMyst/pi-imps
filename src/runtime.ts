import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BridgeServer } from "./bridge.js";
import { GoblinCleanup } from "./goblin-cleanup.js";
import { GoblinLifecycle } from "./goblin-lifecycle.js";
import {
  assertAgentPrompted,
  assertAgentStarted,
  type CommandRunner,
  HerdrCommandError,
  type HerdrResponse,
  herdr,
  parseAgentStatus,
  parseTabCreated,
  runCommand,
} from "./herdr.js";
import { createNamePool } from "./names.js";
import type {
  ChildManifest,
  GoblinSettings,
  GoblinSnapshot,
  OwnedTab,
  ParentHerdrContext,
  ThinkingLevel,
} from "./types.js";
import { buildPiArgs, resolveModel, resolveTools, validateRuntimePaths, validateTask } from "./validation.js";

const LAUNCH_DEADLINE_MS = 60_000;
const START_BUSY_RETRY_MS = 250;
const START_BUSY_WINDOW_MS = 5_000;
const REFRESH_CACHE_MS = 1_000;
const ABORTED = Symbol("aborted");

interface LaunchPlan {
  readonly task: string;
  readonly launchId: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly canonicalModel: string;
  readonly thinking: ThinkingLevel;
  readonly trusted: boolean;
  readonly tools: string[] | undefined;
}

export interface SummonOptions {
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
  readonly parent: ParentHerdrContext;
  readonly runtimeRoot?: string;
  readonly runner?: CommandRunner;
  readonly bridgeFactory?: (manifest: ChildManifest) => BridgeServer;
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

function aborted(signal: AbortSignal | undefined): Promise<typeof ABORTED> | undefined {
  if (!signal) return undefined;
  return new Promise((resolve) => {
    if (signal.aborted) resolve(ABORTED);
    else signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
}

function internalAgentName(launchId: string): string {
  return `goblin-${launchId.replace(/-/g, "").slice(0, 24)}`;
}

export class GoblinRuntime {
  private readonly goblins = new Map<string, GoblinLifecycle>();
  private readonly names = createNamePool();
  private readonly runner: CommandRunner;
  private readonly runtimeRoot: string;
  private readonly cleanup: GoblinCleanup;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly options: RuntimeOptions) {
    this.runner = options.runner ?? runCommand;
    this.cleanup = new GoblinCleanup((args, signal, timeout) => this.command(args, signal, timeout));
    this.runtimeRoot =
      options.runtimeRoot ?? join(process.env.TMPDIR || "/tmp", `pi-goblins-${randomUUID().slice(0, 8)}`);
  }

  summon(options: SummonOptions, cwd: string): string {
    if (this.shutdownPromise) throw new Error("Cannot summon after shutdown has begun");
    const prepared = this.prepare(options);
    const name = this.names.allocate();
    const lifecycle = new GoblinLifecycle(name, prepared.task, prepared.runtimeDir, prepared.socketPath, (terminal) =>
      this.cleanup.schedule(terminal),
    );
    const { record } = lifecycle;
    this.goblins.set(name, lifecycle);
    lifecycle.setLaunchPromise(this.launch(lifecycle, prepared, cwd).catch((error) => record.fail(error)));
    return name;
  }

  private prepare(options: SummonOptions): LaunchPlan {
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
    return {
      task: options.task,
      launchId,
      runtimeDir,
      socketPath,
      canonicalModel: canonical,
      thinking: options.thinking,
      trusted: options.trusted,
      tools: resolveTools(this.options.settings),
    };
  }

  private createBridge(manifest: ChildManifest, lifecycle: GoblinLifecycle): BridgeServer {
    if (this.options.bridgeFactory) return this.options.bridgeFactory(manifest);
    const { record } = lifecycle;
    return new BridgeServer(manifest, {
      onConnect: () => lifecycle.markConnected(),
      onTool: (activity) => record.updateActivity(activity),
      onTurn: (turns, tokens) => record.updateTurn(turns, tokens),
      onResult: (result) => record.acceptResult(result),
      onError: (error) => {
        if (record.isRunning()) record.fail(error);
      },
    });
  }

  private async launch(lifecycle: GoblinLifecycle, prepared: LaunchPlan, cwd: string): Promise<void> {
    const { record } = lifecycle;
    const deadline = Date.now() + LAUNCH_DEADLINE_MS;
    const manifest: ChildManifest = {
      socketPath: lifecycle.socketPath,
      turnLimit: this.options.settings.turnLimit,
    };
    const bridge = this.createBridge(manifest, lifecycle);
    await mkdir(lifecycle.runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(join(lifecycle.runtimeDir, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    }).catch(async (error) => {
      await rm(lifecycle.runtimeDir, { recursive: true, force: true });
      throw error;
    });
    await bridge.listen(lifecycle.runtimeDir);
    lifecycle.attachBridge(bridge);

    const remaining = () => deadline - Date.now();
    const label = record.name;
    const tabResult = await this.command(
      [
        "tab",
        "create",
        "--workspace",
        this.options.parent.workspaceId,
        "--cwd",
        cwd,
        "--label",
        label,
        "--env",
        "PI_GOBLINS_CHILD=1",
        "--env",
        `PI_GOBLINS_MANIFEST=${join(lifecycle.runtimeDir, "manifest.json")}`,
        "--no-focus",
      ],
      lifecycle.controller.signal,
      remaining(),
    );
    const created = parseTabCreated(tabResult);
    if (
      !created ||
      created.tab.workspaceId !== this.options.parent.workspaceId ||
      created.tab.label !== label ||
      created.rootPane.tabId !== created.tab.tabId ||
      created.rootPane.workspaceId !== this.options.parent.workspaceId
    ) {
      throw new Error("Malformed or identity-mismatched Herdr tab creation response");
    }
    const tab: OwnedTab = {
      workspaceId: this.options.parent.workspaceId,
      tabId: created.tab.tabId,
      paneId: created.rootPane.paneId,
      label,
      agentName: internalAgentName(prepared.launchId),
    };
    lifecycle.setTab(tab);

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
            tab.agentName,
            "--kind",
            "pi",
            "--pane",
            tab.paneId,
            "--timeout",
            String(Math.floor(left)),
            "--",
            ...args,
          ],
          lifecycle.controller.signal,
          left,
        );
        assertAgentStarted(started);
        break;
      } catch (error) {
        if (!(error instanceof HerdrCommandError) || error.code !== "agent_pane_busy" || Date.now() >= busyUntil)
          throw error;
        await delay(Math.min(START_BUSY_RETRY_MS, busyUntil - Date.now()), lifecycle.controller.signal);
        if (Date.now() >= busyUntil) throw error;
      }
    }

    if (!lifecycle.isConnected()) {
      await Promise.race([
        lifecycle.connected,
        delay(Math.max(0, remaining()), lifecycle.controller.signal).then(() => {
          throw new Error("Timed out waiting for child bridge connection");
        }),
      ]);
    }
    if (remaining() <= 0) throw new Error("The shared launch deadline expired before prompting");

    const prompted = await this.command(
      ["agent", "prompt", tab.agentName, record.task, "--wait", "--until", "idle", "--until", "done"],
      lifecycle.controller.signal,
    );
    assertAgentPrompted(prompted);
    record.acceptPromptSuccess();
  }

  private command(args: readonly string[], signal?: AbortSignal, timeout?: number): Promise<HerdrResponse> {
    return herdr(args, { runner: this.runner, signal, ...(timeout === undefined ? {} : { timeout }) });
  }

  has(name: string): boolean {
    return this.goblins.has(name);
  }

  hasEligible(names?: readonly string[]): boolean {
    return this.eligible(names ? new Set(names) : undefined).length > 0;
  }

  runningCount(): number {
    let count = 0;
    for (const { record } of this.goblins.values()) {
      if (record.isRunning()) count++;
    }
    return count;
  }

  snapshots(names?: readonly string[]): GoblinSnapshot[] {
    return this.eligible(names ? new Set(names) : undefined).map(({ record }) => record.snapshot());
  }

  async wait(mode: "all" | "first", names?: readonly string[], signal?: AbortSignal): Promise<GoblinSnapshot[]> {
    const filter = names ? new Set(names) : undefined;
    let waiting = this.eligible(filter);
    if (waiting.length === 0) return [];
    const abortPromise = aborted(signal);
    const claimed: GoblinSnapshot[] = [];

    if (mode === "all") {
      const outcome = await Promise.race([
        Promise.all(waiting.map(({ record }) => record.done)).then(() => "done" as const),
        ...(abortPromise ? [abortPromise] : []),
      ]);
      if (outcome === ABORTED || signal?.aborted) return [];
      for (const lifecycle of waiting) {
        const snapshot = this.claim(lifecycle);
        if (snapshot && snapshot.status !== "dismissed") claimed.push(snapshot);
      }
      return claimed;
    }

    for (;;) {
      waiting = this.eligible(filter);
      if (waiting.length === 0) return claimed;
      const outcome = await Promise.race([
        ...waiting.map((lifecycle) => lifecycle.record.done.then(() => lifecycle)),
        ...(abortPromise ? [abortPromise] : []),
      ]);
      if (outcome === ABORTED || signal?.aborted) return [];
      const snapshot = this.claim(outcome);
      if (snapshot && snapshot.status !== "dismissed") {
        claimed.push(snapshot);
        return claimed;
      }
    }
  }

  private eligible(names: ReadonlySet<string> | undefined): GoblinLifecycle[] {
    return [...this.goblins.values()].filter(({ record }) => !names || names.has(record.name));
  }

  private claim(lifecycle: GoblinLifecycle): GoblinSnapshot | undefined {
    const { record } = lifecycle;
    if (record.isRunning() || this.goblins.get(record.name) !== lifecycle) return undefined;
    this.goblins.delete(record.name);
    this.names.release(record.name);
    return record.snapshot();
  }

  dismiss(name: string): string[] {
    const targets =
      name === "all"
        ? [...this.goblins.values()]
        : [this.goblins.get(name)].filter((lifecycle): lifecycle is GoblinLifecycle => Boolean(lifecycle));
    const dismissed: string[] = [];
    for (const lifecycle of targets) {
      const { record } = lifecycle;
      if (record.isRunning()) record.dismiss();
      if (this.claim(lifecycle)) dismissed.push(record.name);
    }
    return dismissed;
  }

  async refreshAll(names?: readonly string[]): Promise<void> {
    const goblins = this.eligible(names ? new Set(names) : undefined);
    await Promise.all(goblins.map((lifecycle) => this.refresh(lifecycle)));
  }

  private async refresh(lifecycle: GoblinLifecycle): Promise<void> {
    await lifecycle.refresh(REFRESH_CACHE_MS, async (tab) => {
      try {
        return parseAgentStatus(await this.command(["agent", "get", tab.paneId], lifecycle.controller.signal, 3_000));
      } catch {
        // Display-only refresh never settles a goblin.
      }
      return undefined;
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      this.dismiss("all");
      await this.cleanup.drain();
    })();
    return this.shutdownPromise;
  }
}
