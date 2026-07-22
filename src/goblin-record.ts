import type { BridgeServer } from "./bridge.js";
import type { GoblinSnapshot, GoblinStatus, HerdrStatus, OwnedTab, TerminalResult } from "./types.js";

const COORDINATION_MS = 3_000;

interface GoblinRecordOptions {
  readonly name: string;
  readonly task: string;
  readonly launchId: string;
  readonly ownerId: string;
  readonly nonce: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly onTerminal: (record: GoblinRecord) => void;
}

export class GoblinRecord {
  readonly name: string;
  readonly task: string;
  readonly launchId: string;
  readonly ownerId: string;
  readonly nonce: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly launchController = new AbortController();
  readonly done: Promise<void>;
  readonly ready: Promise<void>;

  private status: GoblinStatus = "running";
  private turns = 0;
  private tokens = { input: 0, output: 0 };
  private output?: string;
  private error?: string;
  private activity?: string;
  private herdrStatus?: HerdrStatus;
  private bridgeResult?: TerminalResult;
  private promptSucceeded = false;
  private coordinationTimer?: ReturnType<typeof setTimeout>;
  private resolveDone!: () => void;
  private resolveReady!: () => void;
  private bridgeReady = false;
  private tab?: OwnedTab;
  private tabCreateDone?: Promise<void>;
  private launchPromise?: Promise<void>;
  private bridge?: BridgeServer;
  private refreshPromise?: Promise<void>;
  private refreshedAt?: number;
  private cleanupPromise?: Promise<void>;
  private readonly onTerminal: (record: GoblinRecord) => void;

  constructor(options: GoblinRecordOptions) {
    this.name = options.name;
    this.task = options.task;
    this.launchId = options.launchId;
    this.ownerId = options.ownerId;
    this.nonce = options.nonce;
    this.runtimeDir = options.runtimeDir;
    this.socketPath = options.socketPath;
    this.onTerminal = options.onTerminal;
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
  }

  isRunning(): boolean {
    return this.status === "running";
  }

  hasBridgeResult(): boolean {
    return this.bridgeResult !== undefined;
  }

  snapshot(): GoblinSnapshot {
    return Object.freeze({
      name: this.name,
      status: this.status,
      turns: this.turns,
      tokens: Object.freeze({ ...this.tokens }),
      ...(this.output !== undefined ? { output: this.output } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
      ...(this.activity !== undefined ? { activity: this.activity } : {}),
      ...(this.herdrStatus !== undefined ? { herdrStatus: this.herdrStatus } : {}),
    });
  }

  updateActivity(activity: string): void {
    if (this.isRunning()) this.activity = activity;
  }

  updateTurn(turns: number, tokens: { readonly input: number; readonly output: number }): void {
    if (!this.isRunning()) return;
    this.turns = turns;
    this.tokens = { ...tokens };
  }

  markReady(): void {
    if (this.bridgeReady) return;
    this.bridgeReady = true;
    this.resolveReady();
  }

  isReady(): boolean {
    return this.bridgeReady;
  }

  acceptBridgeResult(result: TerminalResult): void {
    if (!this.isRunning() || this.bridgeResult) return;
    this.bridgeResult = Object.freeze({ ...result });
    if (result.status === "truncated") this.terminalize(result);
    else this.coordinate();
  }

  acceptPromptSuccess(): void {
    if (!this.isRunning()) return;
    this.promptSucceeded = true;
    this.coordinate();
  }

  fail(error: unknown): void {
    this.terminalize({
      status: "failed",
      output: this.bridgeResult?.output ?? "",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  dismiss(): boolean {
    return this.terminalize({ status: "dismissed" });
  }

  private coordinate(): void {
    if (!this.isRunning()) return;
    if (this.bridgeResult && this.promptSucceeded) {
      if (this.coordinationTimer) clearTimeout(this.coordinationTimer);
      this.terminalize(this.bridgeResult);
      return;
    }
    if ((this.bridgeResult || this.promptSucceeded) && !this.coordinationTimer) {
      this.coordinationTimer = setTimeout(
        () => this.fail(new Error("Bridge result and Herdr prompt completion did not coordinate within 3 seconds")),
        COORDINATION_MS,
      );
    }
  }

  private terminalize(result: TerminalResult | { readonly status: "dismissed" }): boolean {
    if (!this.isRunning()) return false;
    if (this.coordinationTimer) clearTimeout(this.coordinationTimer);
    this.status = result.status;
    if ("output" in result) this.output = result.output;
    if ("error" in result) this.error = result.error;
    this.resolveDone();
    queueMicrotask(() => this.onTerminal(this));
    return true;
  }

  beginTabCreate(): () => void {
    let finish!: () => void;
    this.tabCreateDone = new Promise<void>((resolve) => (finish = resolve));
    return finish;
  }

  waitForTabCreate(): Promise<void> | undefined {
    return this.tabCreateDone;
  }

  setTab(tab: OwnedTab): void {
    this.tab = tab;
  }

  getTab(): OwnedTab | undefined {
    return this.tab;
  }

  setLaunchPromise(promise: Promise<void>): void {
    this.launchPromise = promise;
  }

  waitForLaunch(): Promise<void> | undefined {
    return this.launchPromise;
  }

  attachBridge(bridge: BridgeServer): void {
    this.bridge = bridge;
  }

  async closeBridge(): Promise<void> {
    const bridge = this.bridge;
    this.bridge = undefined;
    await bridge?.close();
  }

  refresh(
    cacheMs: number,
    run: (tab: OwnedTab) => Promise<HerdrStatus | undefined>,
  ): Promise<void> | undefined {
    if (!this.tab || !this.isRunning()) return undefined;
    if (this.refreshedAt && Date.now() - this.refreshedAt < cacheMs) return undefined;
    if (this.refreshPromise) return this.refreshPromise;
    const tab = this.tab;
    this.refreshPromise = (async () => {
      try {
        const status = await run(tab);
        if (status !== undefined) this.herdrStatus = status;
      } finally {
        this.refreshedAt = Date.now();
        this.refreshPromise = undefined;
      }
    })();
    return this.refreshPromise;
  }

  cleanup(run: () => Promise<void>): Promise<void> {
    if (!this.cleanupPromise) this.cleanupPromise = run();
    return this.cleanupPromise;
  }
}
