import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoblinRuntime } from "./runtime.js";
import { loadGoblinSettings } from "./settings.js";
import { dismissTool, listGoblinsTool, summonTool, waitTool } from "./tools.js";
import type { ParentHerdrContext } from "./types.js";

export default function piGoblins(pi: ExtensionAPI): void {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.PI_GOBLINS_CHILD === "1" || process.env.HERDR_ENV !== "1" || !workspaceId || !tabId || !paneId)
    return;

  const parent: ParentHerdrContext = { workspaceId, tabId, paneId };
  const runtime = new GoblinRuntime({
    settings: loadGoblinSettings(),
    bridgePath: fileURLToPath(new URL("./child-bridge.ts", import.meta.url)),
    parent,
  });

  const updateStatus = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) => {
    const running = [...runtime.goblins.values()].filter((goblin) => goblin.status === "running").length;
    ctx.ui.setStatus("goblins", running ? `${running} goblin${running === 1 ? "" : "s"}` : undefined);
  };

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("turn_start", (_event, ctx) => updateStatus(ctx));
  pi.on("turn_end", (_event, ctx) => updateStatus(ctx));
  pi.on("tool_execution_end", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", async () => runtime.shutdown());

  pi.registerTool(summonTool(runtime, () => pi.getThinkingLevel()));
  pi.registerTool(waitTool(runtime));
  pi.registerTool(dismissTool(runtime));
  pi.registerTool(listGoblinsTool(runtime));
}
