import { readFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getPackageDir } from "@earendil-works/pi-coding-agent";
import type { BridgeMessage, ChildManifest, TerminalResult } from "./types.js";

const FINAL_TURN_DIRECTIVE =
  "FINAL TURN. Do not start new work. Save any pending changes, commit your progress, and respond with: (1) what you completed, (2) what remains unfinished.";

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function preview(toolName: string, args: Record<string, unknown>): string {
  const value = Object.values(args).find((candidate) => typeof candidate === "string" && candidate.length > 0);
  const detail = typeof value === "string" ? ` ${value}` : "";
  return [...`→ ${toolName}${detail}`]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, 240);
}

function codingAgentVersion(): string {
  try {
    return JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")).version as string;
  } catch {
    return "unknown";
  }
}

export default function childBridge(pi: ExtensionAPI): void {
  const manifestPath = process.env.PI_IMPS_MANIFEST;
  if (process.env.PI_IMPS_CHILD !== "1" || !manifestPath) return;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ChildManifest;
  let socket: Socket | undefined;
  let writes = Promise.resolve();
  let terminal = false;
  let turns = 0;
  const tokens = { input: 0, output: 0 };
  let latest: AssistantMessage | undefined;

  function send(payload: Record<string, unknown> & { type: BridgeMessage["type"] }): Promise<void> {
    const message = { ...payload, ownerId: manifest.ownerId, launchId: manifest.launchId } as BridgeMessage;
    writes = writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (!socket || socket.destroyed) return reject(new Error("Bridge socket is closed"));
          socket.write(`${JSON.stringify(message)}\n`, "utf8", (error) => (error ? reject(error) : resolve()));
        }),
    );
    return writes;
  }

  async function sendResult(result: TerminalResult): Promise<void> {
    if (terminal) return;
    terminal = true;
    await send({ type: "result", ...result });
  }

  pi.on("session_start", async () => {
    socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      socket?.once("error", reject);
      socket?.connect(manifest.socketPath, () => {
        socket?.removeListener("error", reject);
        socket?.on("error", () => {});
        resolve();
      });
    });
    await send({
      type: "ready",
      protocol: manifest.protocol,
      nonce: manifest.nonce,
      version: codingAgentVersion(),
    });
  });

  pi.on("tool_execution_start", (event) => {
    void send({ type: "tool", preview: preview(event.toolName, event.args) }).catch(() => {});
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") latest = event.message;
  });

  pi.on("turn_end", async (event, ctx) => {
    turns++;
    if (event.message.role === "assistant") {
      latest = event.message;
      tokens.input += event.message.usage.input;
      tokens.output += event.message.usage.output;
    }
    await send({ type: "turn", turns, tokens: { ...tokens } });
    if (turns === manifest.turnLimit - 1) {
      pi.sendUserMessage(FINAL_TURN_DIRECTIVE, { deliverAs: "steer" });
    }
    if (turns >= manifest.turnLimit) {
      await sendResult({ status: "truncated", output: latest ? assistantText(latest) : "" });
      ctx.abort();
    }
  });

  pi.on("agent_settled", async () => {
    if (terminal) return;
    const output = latest ? assistantText(latest) : "";
    if (latest?.stopReason === "error") {
      await sendResult({ status: "failed", output, error: latest.errorMessage ?? "Provider request failed" });
    } else {
      await sendResult({ status: "completed", output });
    }
  });

  pi.on("session_shutdown", async () => {
    await writes.catch(() => {});
    socket?.end();
    socket?.destroy();
  });
}
