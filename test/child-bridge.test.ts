import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import childBridge from "../src/child-bridge.js";
import type { ChildManifest } from "../src/types.js";

interface Harness {
  root: string;
  manifest: ChildManifest;
  server: Server;
  client?: Socket;
  messages: Array<Record<string, unknown>>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

const harnesses: Harness[] = [];

function assistant(textBlocks: string[], stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private" },
      ...textBlocks.map((text) => ({ type: "text", text })),
      { type: "toolCall", id: "tool", name: "read", arguments: {} },
    ],
    stopReason,
    errorMessage,
    usage: { input: 3, output: 5 },
  } as unknown as AssistantMessage;
}

async function createHarness(turnLimit = 3): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "pi-goblins-child-"));
  const manifest: ChildManifest = {
    socketPath: join(root, "bridge.sock"),
    turnLimit,
  };
  const messages: Array<Record<string, unknown>> = [];
  let buffered = "";
  const harness = {
    root,
    manifest,
    messages,
    handlers: new Map(),
    sendUserMessage: vi.fn(),
  } as unknown as Harness;
  const server = createServer((socket) => {
    harness.client = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        messages.push(JSON.parse(buffered.slice(0, newline)));
        buffered = buffered.slice(newline + 1);
      }
    });
  });
  harness.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(manifest.socketPath, resolve);
  });
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  process.env.PI_GOBLINS_CHILD = "1";
  process.env.PI_GOBLINS_MANIFEST = manifestPath;
  const pi = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => harness.handlers.set(name, handler),
    sendUserMessage: harness.sendUserMessage,
  } as unknown as ExtensionAPI;
  childBridge(pi);
  await harness.handlers.get("session_start")?.({}, {});
  harnesses.push(harness);
  return harness;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for child bridge message");
}

afterEach(async () => {
  delete process.env.PI_GOBLINS_CHILD;
  delete process.env.PI_GOBLINS_MANIFEST;
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      harness.client?.destroy();
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await rm(harness.root, { recursive: true, force: true });
    }),
  );
});

describe("child bridge", () => {
  it("returns only the latest assistant message text blocks without separators", async () => {
    const harness = await createHarness();
    await harness.handlers.get("message_end")?.({ message: assistant(["old"]) }, {});
    await harness.handlers.get("message_end")?.({ message: assistant(["first", "\nsecond"]) }, {});
    await harness.handlers.get("agent_settled")?.({}, {});
    await eventually(() => harness.messages.some((message) => message.type === "result"));

    expect(harness.messages.find((message) => message.type === "result")).toMatchObject({
      status: "completed",
      output: "first\nsecond",
    });
  });

  it("preserves provider failure partial output and error", async () => {
    const harness = await createHarness();
    await harness.handlers.get("message_end")?.(
      { message: assistant(["partial"], "error", "provider unavailable") },
      {},
    );
    await harness.handlers.get("agent_settled")?.({}, {});
    await eventually(() => harness.messages.some((message) => message.type === "result"));

    expect(harness.messages.find((message) => message.type === "result")).toMatchObject({
      status: "failed",
      output: "partial",
      error: "provider unavailable",
    });
  });

  it("steers before the final turn and drains truncated result before aborting", async () => {
    const harness = await createHarness(2);
    const abort = vi.fn();
    await harness.handlers.get("turn_end")?.({ message: assistant(["first"]) }, { abort });
    expect(harness.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("FINAL TURN"), { deliverAs: "steer" });

    await harness.handlers.get("turn_end")?.({ message: assistant(["final"]) }, { abort });
    expect(abort).toHaveBeenCalledOnce();
    await eventually(() => harness.messages.some((message) => message.type === "result"));
    expect(harness.messages.find((message) => message.type === "result")).toMatchObject({
      status: "truncated",
      output: "final",
    });
    expect(harness.messages.filter((message) => message.type === "turn").at(-1)).toMatchObject({
      turns: 2,
      tokens: { input: 6, output: 10 },
    });
  });
});
