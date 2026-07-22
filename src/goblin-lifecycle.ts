import type { BridgeServer } from "./bridge.js";
import { GoblinRecord } from "./goblin-record.js";
import type { HerdrStatus, OwnedTab } from "./types.js";

export class GoblinLifecycle {
  readonly controller = new AbortController();
  readonly connected: Promise<void>;
  readonly record: GoblinRecord;

  private resolveConnected!: () => void;
  private bridgeConnected = false;
  private tab?: OwnedTab;
  private launchPromise?: Promise<void>;
  private bridge?: BridgeServer;
  private refreshPromise?: Promise<void>;
  private refreshedAt?: number;
  private cleanupPromise?: Promise<void>;

  constructor(
    name: string,
    task: string,
    readonly runtimeDir: string,
    readonly socketPath: string,
    onTerminal: (lifecycle: GoblinLifecycle) => void,
  ) {
    this.record = new GoblinRecord({ name, task, onTerminal: () => onTerminal(this) });
    this.connected = new Promise((resolve) => (this.resolveConnected = resolve));
  }

  markConnected(): void {
    if (this.bridgeConnected) return;
    this.bridgeConnected = true;
    this.resolveConnected();
  }

  isConnected(): boolean {
    return this.bridgeConnected;
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
    if (!this.tab || !this.record.isRunning()) return undefined;
    if (this.refreshedAt && Date.now() - this.refreshedAt < cacheMs) return undefined;
    if (this.refreshPromise) return this.refreshPromise;
    const tab = this.tab;
    this.refreshPromise = (async () => {
      try {
        const status = await run(tab);
        if (status !== undefined) this.record.updateHerdrStatus(status);
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
