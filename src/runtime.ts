import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BridgeServer } from "./bridge.js";
import { GoblinRecord } from "./goblin-record.js";
import {
  type CommandRunner,
  type HerdrAgent,
  HerdrCommandError,
  type HerdrResponse,
  herdr,
  Prerequisites,
  parseAgentInfo,
  parseAgentPrompted,
  parseAgentStarted,
  parsePaneInfo,
  parseTabCreated,
  parseTabInfo,
  parseWorkspaceInfo,
  runCommand,
  shouldInvalidatePreflight,
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
const SHUTDOWN_BARRIER_MS = 65_000;
const ABORTED = Symbol("aborted");

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
  readonly parent: ParentHerdrContext;
  readonly runtimeRoot?: string;
  readonly runner?: CommandRunner;
  readonly prerequisites?: Prerequisites;
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

function identityMatches(agent: HerdrAgent, tab: OwnedTab): boolean {
  return agent.workspaceId === tab.workspaceId && agent.paneId === tab.paneId && agent.name === tab.agentName;
}

export class GoblinRuntime {
  readonly ownerId = randomUUID();
  private readonly records = new Map<string, GoblinRecord>();
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

  private async validateParent(): Promise<void> {
    const { workspaceId, tabId, paneId } = this.options.parent;
    const [workspaceResult, tabResult, paneResult] = await Promise.all([
      this.command(["workspace", "get", workspaceId], undefined, 3_000),
      this.command(["tab", "get", tabId], undefined, 3_000),
      this.command(["pane", "get", paneId], undefined, 3_000),
    ]);
    const workspace = parseWorkspaceInfo(workspaceResult);
    const tab = parseTabInfo(tabResult);
    const pane = parsePaneInfo(paneResult);
    if (
      workspace?.workspaceId !== workspaceId ||
      tab?.tabId !== tabId ||
      tab.workspaceId !== workspaceId ||
      pane?.paneId !== paneId ||
      pane.tabId !== tabId ||
      pane.workspaceId !== workspaceId
    ) {
      throw new Error("Inherited Herdr workspace, tab, and pane identity mismatch");
    }
  }

  async prepare(options: PrepareOptions): Promise<PreparedLaunch> {
    await this.prerequisites.check();
    await this.validateParent();
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

  summon(prepared: PreparedLaunch, cwd: string): string {
    const name = this.names.allocate();
    const record = new GoblinRecord({
      name,
      task: prepared.task,
      launchId: prepared.launchId,
      ownerId: this.ownerId,
      nonce: prepared.nonce,
      runtimeDir: prepared.runtimeDir,
      socketPath: prepared.socketPath,
      onTerminal: (terminal) => this.trackCleanup(terminal),
    });
    this.records.set(name, record);
    record.setLaunchPromise(this.launch(record, prepared, cwd).catch((error) => record.fail(error)));
    return name;
  }

  private createBridge(manifest: ChildManifest, record: GoblinRecord): BridgeServer {
    if (this.options.bridgeFactory) return this.options.bridgeFactory(manifest);
    return new BridgeServer(manifest, {
      onReady: () => record.markReady(),
      onTool: (activity) => record.updateActivity(activity),
      onTurn: (turns, tokens) => record.updateTurn(turns, tokens),
      onResult: (result) => record.acceptBridgeResult(result),
      onError: (error) => {
        if (shouldInvalidatePreflight(error)) this.prerequisites.invalidate();
        if (record.isRunning() && !record.hasBridgeResult()) record.fail(error);
      },
    });
  }

  private async launch(record: GoblinRecord, prepared: PreparedLaunch, cwd: string): Promise<void> {
    const deadline = Date.now() + LAUNCH_DEADLINE_MS;
    const manifest: ChildManifest = {
      protocol: 1,
      ownerId: record.ownerId,
      launchId: record.launchId,
      nonce: record.nonce,
      socketPath: record.socketPath,
      turnLimit: this.options.settings.turnLimit,
    };
    const bridge = this.createBridge(manifest, record);
    await mkdir(record.runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(join(record.runtimeDir, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    }).catch(async (error) => {
      await rm(record.runtimeDir, { recursive: true, force: true });
      throw error;
    });
    await bridge.listen(record.runtimeDir);
    record.attachBridge(bridge);

    const remaining = () => deadline - Date.now();
    const label = `pi-goblin-${record.name}-${record.launchId}`;
    const finishTabCreate = record.beginTabCreate();
    let tabResult: HerdrResponse;
    try {
      tabResult = await this.command(
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
          `PI_GOBLINS_MANIFEST=${join(record.runtimeDir, "manifest.json")}`,
          "--no-focus",
        ],
        record.launchController.signal,
        remaining(),
      );
    } finally {
      finishTabCreate();
    }
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
      agentName: internalAgentName(record.launchId),
    };
    record.setTab(tab);

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
          record.launchController.signal,
          left,
        );
        const agent = parseAgentStarted(started);
        if (!agent || !identityMatches(agent, tab)) {
          throw new Error("Herdr agent start identity mismatch");
        }
        break;
      } catch (error) {
        if (!(error instanceof HerdrCommandError) || error.code !== "agent_pane_busy" || Date.now() >= busyUntil)
          throw error;
        await delay(Math.min(START_BUSY_RETRY_MS, busyUntil - Date.now()), record.launchController.signal);
        if (Date.now() >= busyUntil) throw error;
      }
    }

    if (!record.isReady()) {
      await Promise.race([
        record.ready,
        delay(Math.max(0, remaining()), record.launchController.signal).then(() => {
          throw new Error("Timed out waiting for authenticated child readiness");
        }),
      ]);
    }
    if (remaining() <= 0) throw new Error("The shared launch deadline expired before prompting");

    const prompted = await this.command(
      ["agent", "prompt", tab.agentName, record.task, "--wait", "--until", "idle", "--until", "done"],
      record.launchController.signal,
    );
    const promptAgent = parseAgentPrompted(prompted);
    if (!promptAgent || !identityMatches(promptAgent, tab)) {
      throw new Error("Herdr prompt response identity mismatch");
    }
    record.acceptPromptSuccess();
  }

  private async command(
    args: readonly string[],
    signal?: AbortSignal,
    timeout?: number,
  ): Promise<HerdrResponse> {
    try {
      return await herdr(args, { runner: this.runner, signal, ...(timeout === undefined ? {} : { timeout }) });
    } catch (error) {
      if (shouldInvalidatePreflight(error)) this.prerequisites.invalidate();
      throw error;
    }
  }

  has(name: string): boolean {
    return this.records.has(name);
  }

  hasEligible(names?: readonly string[]): boolean {
    return this.eligible(names ? new Set(names) : undefined).length > 0;
  }

  runningCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.isRunning()) count++;
    }
    return count;
  }

  snapshots(names?: readonly string[]): GoblinSnapshot[] {
    return this.eligible(names ? new Set(names) : undefined).map((record) => record.snapshot());
  }

  async wait(
    mode: "all" | "first",
    names?: readonly string[],
    signal?: AbortSignal,
  ): Promise<GoblinSnapshot[]> {
    const filter = names ? new Set(names) : undefined;
    let waiting = this.eligible(filter);
    if (waiting.length === 0) return [];
    const abortPromise = aborted(signal);
    const claimed: GoblinSnapshot[] = [];

    if (mode === "all") {
      const outcome = await Promise.race([
        Promise.all(waiting.map((record) => record.done)).then(() => "done" as const),
        ...(abortPromise ? [abortPromise] : []),
      ]);
      if (outcome === ABORTED || signal?.aborted) return [];
      for (const record of waiting) {
        const snapshot = this.claim(record);
        if (snapshot && snapshot.status !== "dismissed") claimed.push(snapshot);
      }
      return claimed;
    }

    for (;;) {
      waiting = this.eligible(filter);
      if (waiting.length === 0) return claimed;
      const outcome = await Promise.race([
        ...waiting.map((record) => record.done.then(() => record)),
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

  private eligible(names: ReadonlySet<string> | undefined): GoblinRecord[] {
    return [...this.records.values()].filter((record) => !names || names.has(record.name));
  }

  private claim(record: GoblinRecord): GoblinSnapshot | undefined {
    if (record.isRunning() || this.records.get(record.name) !== record) return undefined;
    this.records.delete(record.name);
    this.names.release(record.name);
    const snapshot = record.snapshot();
    this.trackCleanup(record);
    return snapshot;
  }

  dismiss(name: string): string[] {
    const targets =
      name === "all"
        ? [...this.records.values()]
        : [this.records.get(name)].filter((record): record is GoblinRecord => Boolean(record));
    const dismissed: string[] = [];
    for (const record of targets) {
      if (record.isRunning()) record.dismiss();
      if (this.claim(record)) dismissed.push(record.name);
    }
    return dismissed;
  }

  async refreshAll(names?: readonly string[]): Promise<void> {
    const records = this.eligible(names ? new Set(names) : undefined);
    await Promise.all(records.map((record) => this.refresh(record)));
  }

  private async refresh(record: GoblinRecord): Promise<void> {
    await record.refresh(REFRESH_CACHE_MS, async (tab) => {
      try {
        const agent = parseAgentInfo(
          await this.command(["agent", "get", tab.agentName], record.launchController.signal, 3_000),
        );
        if (agent && identityMatches(agent, tab)) return agent.agentStatus;
      } catch {
        // Display-only refresh never settles a goblin.
      }
      return undefined;
    });
  }

  private trackCleanup(record: GoblinRecord): void {
    const cleanup = this.cleanup(record);
    this.cleanups.add(cleanup);
    cleanup.finally(() => this.cleanups.delete(cleanup)).catch(() => {});
  }

  private cleanup(record: GoblinRecord): Promise<void> {
    return record.cleanup(async () => {
      await record.waitForTabCreate()?.catch(() => {});
      record.launchController.abort();
      await record.waitForLaunch()?.catch(() => {});
      const tab = record.getTab();
      if (tab) {
        try {
          const pane = parsePaneInfo(await this.command(["pane", "get", tab.paneId], undefined, 3_000));
          const paneOwned =
            pane?.paneId === tab.paneId && pane.tabId === tab.tabId && pane.workspaceId === tab.workspaceId;
          if (paneOwned) {
            let live = false;
            try {
              const agent = parseAgentInfo(await this.command(["agent", "get", tab.agentName], undefined, 2_000));
              live = Boolean(
                agent && identityMatches(agent, tab) && agent.agentStatus !== "idle" && agent.agentStatus !== "done",
              );
            } catch {}
            if (live) {
              await this.command(["agent", "send-keys", tab.agentName, "esc"], undefined, 2_000).catch(() => {});
              await this.command(
                ["agent", "wait", tab.agentName, "--until", "idle", "--until", "done", "--timeout", "2000"],
                undefined,
                3_000,
              ).catch(() => {});
            }
            const [currentTabResult, currentPaneResult, parentTabResult] = await Promise.all([
              this.command(["tab", "get", tab.tabId], undefined, 3_000),
              this.command(["pane", "get", tab.paneId], undefined, 3_000),
              this.command(["tab", "get", this.options.parent.tabId], undefined, 3_000),
            ]);
            const currentTab = parseTabInfo(currentTabResult);
            const currentPane = parsePaneInfo(currentPaneResult);
            const parentTab = parseTabInfo(parentTabResult);
            const parentStillOwned =
              parentTab?.tabId === this.options.parent.tabId && parentTab.workspaceId === tab.workspaceId;
            const paneStillOwned =
              currentPane?.paneId === tab.paneId &&
              currentPane.tabId === tab.tabId &&
              currentPane.workspaceId === tab.workspaceId;
            const tabStillExclusive =
              currentTab?.tabId === tab.tabId &&
              currentTab.workspaceId === tab.workspaceId &&
              currentTab.label === tab.label &&
              currentTab.paneCount === 1;
            if (parentStillOwned && paneStillOwned && tabStillExclusive) {
              await this.command(["tab", "close", tab.tabId], undefined, 5_000).catch(() => {});
            } else if (parentStillOwned && paneStillOwned) {
              await this.command(["pane", "close", tab.paneId], undefined, 5_000).catch(() => {});
            }
          }
        } catch {}
      }
      await record.closeBridge().catch(() => {});
      await rm(record.runtimeDir, { recursive: true, force: true });
    });
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
