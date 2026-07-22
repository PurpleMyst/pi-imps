import type { BridgeServer } from "./bridge.js";
import type { GoblinSnapshot, GoblinStatus, HerdrStatus, OwnedTab, TerminalResult } from "./types.js";

const MISSING_RESULT_GRACE_MS = 1_000;

interface GoblinRecordOptions {
  readonly name: string;
  readonly task: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly onTerminal: (record: GoblinRecord) => void;
}

export class GoblinRecord {
  readonly name: string;
  readonly task: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly launchController = new AbortController();
  readonly done: Promise<void>;
  readonly connected: Promise<void>;

  private status: GoblinStatus = "running";
  private turns = 0;
  private tokens = { input: 0, output: 0 };
  private output?: string;
  private error?: string;
  private activity?: string;
  private herdrStatus?: HerdrStatus;
  private missingResultTimer?: ReturnType<typeof setTimeout>;
  private resolveDone!: () => void;
  private resolveConnected!: () => void;
  private bridgeConnected = false;
  private tab?: OwnedTab;
  private launchPromise?: Promise<void>;
  private bridge?: BridgeServer;
  private refreshPromise?: Promise<void>;
  private refreshedAt?: number;
  private cleanupPromise?: Promise<void>;
  private readonly onTerminal: (record: GoblinRecord) => void;

  constructor(options: GoblinRecordOptions) {
    this.name = options.name;
    this.task = options.task;
    this.runtimeDir = options.runtimeDir;
    this.socketPath = options.socketPath;
    this.onTerminal = options.onTerminal;
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
    this.connected = new Promise((resolve) => (this.resolveConnected = resolve));
  }

  isRunning(): boolean {
    return this.status === "running";
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

  markConnected(): void {
    if (this.bridgeConnected) return;
    this.bridgeConnected = true;
    this.resolveConnected();
  }

  isConnected(): boolean {
    return this.bridgeConnected;
  }

  acceptResult(result: TerminalResult): void {
    this.terminalize(result);
  }

  acceptPromptSuccess(): void {
    if (!this.isRunning() || this.missingResultTimer) return;
    this.missingResultTimer = setTimeout(
      () => this.fail(new Error("Child did not publish a result after the prompt completed")),
      MISSING_RESULT_GRACE_MS,
    );
  }

  fail(error: unknown): void {
    this.terminalize({
      status: "failed",
      output: "",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  dismiss(): boolean {
    return this.terminalize({ status: "dismissed" });
  }

  private terminalize(result: TerminalResult | { readonly status: "dismissed" }): boolean {
    if (!this.isRunning()) return false;
    if (this.missingResultTimer) clearTimeout(this.missingResultTimer);
    this.status = result.status;
    if (result.status !== "dismissed") this.output = result.output;
    if (result.status === "failed") this.error = result.error;
    this.resolveDone();
    queueMicrotask(() => this.onTerminal(this));
    return true;
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

  refresh(cacheMs: number, run: (tab: OwnedTab) => Promise<HerdrStatus | undefined>): Promise<void> | undefined {
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
