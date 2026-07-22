import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ImpRuntime } from "./runtime.js";
import { loadImpSettings } from "./settings.js";
import { dismissTool, listImpsTool, summonTool, waitTool } from "./tools.js";

export default function piImps(pi: ExtensionAPI): void {
  if (process.env.PI_IMPS_CHILD === "1") return;

  const runtime = new ImpRuntime({
    settings: loadImpSettings(),
    bridgePath: fileURLToPath(new URL("./child-bridge.ts", import.meta.url)),
  });

  const updateStatus = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) => {
    const running = [...runtime.imps.values()].filter((imp) => imp.status === "running").length;
    ctx.ui.setStatus("imps", running ? `${running} imp${running === 1 ? "" : "s"}` : undefined);
  };

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("turn_start", (_event, ctx) => updateStatus(ctx));
  pi.on("turn_end", (_event, ctx) => updateStatus(ctx));
  pi.on("tool_execution_end", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", async () => runtime.shutdown());

  pi.registerTool(summonTool(runtime, () => pi.getThinkingLevel()));
  pi.registerTool(waitTool(runtime));
  pi.registerTool(dismissTool(runtime));
  pi.registerTool(listImpsTool(runtime));
}
