import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoblinRuntime } from "./runtime.js";
import { loadGoblinSettings } from "./settings.js";
import { dismissTool, listGoblinsTool, summonTool, waitTool } from "./tools.js";

export default function piGoblins(pi: ExtensionAPI): void {
  if (process.env.PI_GOBLINS_CHILD === "1") return;

  const runtime = new GoblinRuntime({
    settings: loadGoblinSettings(),
    bridgePath: fileURLToPath(new URL("./child-bridge.ts", import.meta.url)),
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
