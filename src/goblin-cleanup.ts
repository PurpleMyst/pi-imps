import { rm } from "node:fs/promises";
import type { GoblinRecord } from "./goblin-record.js";
import { type HerdrAgent, type HerdrResponse, parseAgentInfo, parsePaneInfo, parseTabInfo } from "./herdr.js";
import type { OwnedTab } from "./types.js";

const SHUTDOWN_BARRIER_MS = 65_000;

type HerdrCommand = (args: readonly string[], signal?: AbortSignal, timeout?: number) => Promise<HerdrResponse>;

function identityMatches(agent: HerdrAgent, tab: OwnedTab): boolean {
  return agent.workspaceId === tab.workspaceId && agent.paneId === tab.paneId && agent.name === tab.agentName;
}

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
    await record.waitForTabCreate()?.catch(() => {});
    record.launchController.abort();
    await record.waitForLaunch()?.catch(() => {});

    const tab = record.getTab();
    if (tab) await this.closeOwnedResource(tab);
    await record.closeBridge().catch(() => {});
    await rm(record.runtimeDir, { recursive: true, force: true });
  }

  private async closeOwnedResource(tab: OwnedTab): Promise<void> {
    const pane = await this.inspectPane(tab);
    if (!pane) return;

    await this.interruptLiveAgent(tab);
    const [paneStillOwned, currentTab] = await Promise.all([this.inspectPane(tab), this.inspectTab(tab)]);
    if (!paneStillOwned) return;
    if (currentTab?.exclusive) {
      await this.command(["tab", "close", tab.tabId], undefined, 5_000).catch(() => {});
    } else {
      await this.command(["pane", "close", tab.paneId], undefined, 5_000).catch(() => {});
    }
  }

  private async inspectPane(tab: OwnedTab): Promise<boolean> {
    try {
      const pane = parsePaneInfo(await this.command(["pane", "get", tab.paneId], undefined, 3_000));
      return Boolean(pane?.paneId === tab.paneId && pane.tabId === tab.tabId && pane.workspaceId === tab.workspaceId);
    } catch {
      return false;
    }
  }

  private async inspectTab(tab: OwnedTab): Promise<{ readonly exclusive: boolean } | undefined> {
    try {
      const current = parseTabInfo(await this.command(["tab", "get", tab.tabId], undefined, 3_000));
      if (current?.tabId !== tab.tabId || current.workspaceId !== tab.workspaceId || current.label !== tab.label) {
        return undefined;
      }
      return { exclusive: current.paneCount === 1 };
    } catch {
      return undefined;
    }
  }

  private async interruptLiveAgent(tab: OwnedTab): Promise<void> {
    try {
      const agent = parseAgentInfo(await this.command(["agent", "get", tab.agentName], undefined, 2_000));
      if (!agent || !identityMatches(agent, tab) || agent.agentStatus === "idle" || agent.agentStatus === "done")
        return;
      await this.command(["agent", "send-keys", tab.agentName, "esc"], undefined, 2_000).catch(() => {});
      await this.command(
        ["agent", "wait", tab.agentName, "--until", "idle", "--until", "done", "--timeout", "2000"],
        undefined,
        3_000,
      ).catch(() => {});
    } catch {
      // Interruption is best effort; ownership checks still govern resource cleanup.
    }
  }
}
