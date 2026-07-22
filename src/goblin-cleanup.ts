import { rm } from "node:fs/promises";
import type { GoblinRecord } from "./goblin-record.js";
import { type HerdrResponse, parseTabInfo } from "./herdr.js";

const SHUTDOWN_BARRIER_MS = 65_000;

type HerdrCommand = (args: readonly string[], signal?: AbortSignal, timeout?: number) => Promise<HerdrResponse>;

export class GoblinCleanup {
  private readonly active = new Set<Promise<void>>();

  constructor(private readonly command: HerdrCommand) {}

  schedule(record: GoblinRecord): void {
    const cleanup = record.cleanup(() => this.run(record));
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

  private async run(record: GoblinRecord): Promise<void> {
    record.launchController.abort();
    await record.waitForLaunch()?.catch(() => {});

    const tab = record.getTab();
    if (tab) {
      try {
        const current = parseTabInfo(await this.command(["tab", "get", tab.tabId], undefined, 3_000));
        if (current?.tabId === tab.tabId && current.label === tab.label) {
          await this.command(["tab", "close", tab.tabId], undefined, 5_000).catch(() => {});
        }
      } catch {
        // The tab may already be gone; cleanup continues independently.
      }
    }
    await record.closeBridge().catch(() => {});
    await rm(record.runtimeDir, { recursive: true, force: true });
  }
}
