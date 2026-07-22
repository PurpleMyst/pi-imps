import { rm } from "node:fs/promises";
import type { GoblinLifecycle } from "./goblin-lifecycle.js";
import type { HerdrResponse } from "./herdr.js";

const SHUTDOWN_BARRIER_MS = 65_000;

type HerdrCommand = (args: readonly string[], signal?: AbortSignal, timeout?: number) => Promise<HerdrResponse>;

export class GoblinCleanup {
  private readonly active = new Set<Promise<void>>();

  constructor(private readonly command: HerdrCommand) {}

  schedule(lifecycle: GoblinLifecycle): void {
    const cleanup = lifecycle.cleanup(() => this.run(lifecycle));
    this.active.add(cleanup);
    cleanup.finally(() => this.active.delete(cleanup)).catch(() => {});
  }

  async drain(): Promise<void> {
    const active = Promise.allSettled([...this.active]);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_BARRIER_MS);
      void active.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async run(lifecycle: GoblinLifecycle): Promise<void> {
    lifecycle.controller.abort();
    await lifecycle.waitForLaunch()?.catch(() => {});

    const tab = lifecycle.getTab();
    if (tab) {
      await this.command(["tab", "close", tab.tabId], undefined, 5_000).catch(() => {});
    }
    await lifecycle.closeBridge().catch(() => {});
    await rm(lifecycle.runtimeDir, { recursive: true, force: true });
  }
}
