import { readFileSync } from "node:fs";
import { Socket } from "node:net";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseChildManifest } from "./bridge-protocol.js";
import type { ChildEvent, TerminalResult } from "./types.js";

const WRAP_UP_DIRECTIVE =
  "10 TURNS REMAIN. Stop expanding scope. Prioritize completing the requested work, running verification, and committing finished changes. If everything cannot be completed, leave the working tree coherent and report what remains.";

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function preview(toolName: string, args: Record<string, unknown>): string {
  const value = Object.values(args).find((candidate) => typeof candidate === "string" && candidate.length > 0);
  return [...`→ ${toolName}${typeof value === "string" ? ` ${value}` : ""}`]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, 240);
}

export default function childBridge(pi: ExtensionAPI): void {
  const manifestPath = process.env.PI_GOBLINS_MANIFEST;
  if (process.env.PI_GOBLINS_CHILD !== "1" || !manifestPath) return;

  const manifest = parseChildManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  let socket: Socket | undefined;
  let writes = Promise.resolve();
  let terminal = false;
  let turns = 0;
  const tokens = { input: 0, output: 0 };
  let latest: AssistantMessage | undefined;

  function send(event: ChildEvent): Promise<void> {
    writes = writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (!socket || socket.destroyed) return reject(new Error("Bridge socket is closed"));
          socket.write(`${JSON.stringify(event)}\n`, "utf8", (error) => (error ? reject(error) : resolve()));
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
    if (turns === manifest.turnLimit - 10) pi.sendUserMessage(WRAP_UP_DIRECTIVE, { deliverAs: "steer" });
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
