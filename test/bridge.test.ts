import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeServer, RESULT_LIMIT, TELEMETRY_LIMIT } from "../src/bridge.js";
import type { ChildManifest, TerminalResult } from "../src/types.js";

interface Harness {
  readonly bridge: BridgeServer;
  readonly manifest: ChildManifest;
  readonly socket: Socket;
  readonly ready: string[];
  readonly tools: string[];
  readonly turns: Array<{ turns: number; tokens: { input: number; output: number } }>;
  readonly results: TerminalResult[];
  readonly errors: Error[];
  readonly runtimeDir: string;
}

const harnesses: Harness[] = [];

async function createHarness(): Promise<Harness> {
  const runtimeDir = await mkdtemp(join(tmpdir(), "pi-goblins-"));
  const manifest: ChildManifest = {
    protocol: 1,
    ownerId: "owner",
    launchId: "launch",
    nonce: "nonce",
    socketPath: join(runtimeDir, "bridge.sock"),
    turnLimit: 3,
  };
  const ready: string[] = [];
  const tools: string[] = [];
  const turns: Harness["turns"] = [];
  const results: TerminalResult[] = [];
  const errors: Error[] = [];
  const bridge = new BridgeServer(manifest, {
    onReady: (version) => ready.push(version),
    onTool: (preview) => tools.push(preview),
    onTurn: (turn, tokens) => turns.push({ turns: turn, tokens }),
    onResult: (result) => results.push(result),
    onError: (error) => errors.push(error),
  });
  await bridge.listen(runtimeDir);
  const socket = new Socket();
  socket.on("error", () => {});
  socket.connect(manifest.socketPath);
  await once(socket, "connect");
  const harness = { bridge, manifest, socket, ready, tools, turns, results, errors, runtimeDir };
  harnesses.push(harness);
  return harness;
}

async function send(socket: Socket, message: object): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for bridge event");
}

function message(harness: Harness, payload: Record<string, unknown>): Record<string, unknown> {
  return { ownerId: harness.manifest.ownerId, launchId: harness.manifest.launchId, ...payload };
}

function readyMessage(harness: Harness, version = "0.81.1"): Record<string, unknown> {
  return message(harness, { type: "ready", protocol: 1, nonce: harness.manifest.nonce, version });
}

function paddedMessage(base: Record<string, unknown>, bytes: number): Record<string, unknown> {
  const padding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(base)) - Buffer.byteLength(',"padding":""'));
  const value = { ...base, padding };
  expect(Buffer.byteLength(JSON.stringify(value))).toBe(bytes);
  return value;
}

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async ({ bridge, socket, runtimeDir }) => {
      socket.destroy();
      await bridge.close();
      await rm(runtimeDir, { recursive: true, force: true });
    }),
  );
});

describe("BridgeServer", () => {
  it("accepts an authenticated ready message with the supported identity and version", async () => {
    const harness = await createHarness();

    await send(harness.socket, readyMessage(harness));
    await eventually(() => harness.ready.length === 1);

    expect(harness.ready).toEqual(["0.81.1"]);
    expect(harness.errors).toEqual([]);
  });

  it.each([
    ["owner identity", { ownerId: "other" }],
    ["nonce", { nonce: "other" }],
  ])("rejects an invalid ready %s without consuming the authenticated slot", async (_boundary, override) => {
    const harness = await createHarness();

    await send(harness.socket, { ...readyMessage(harness), ...override });
    await eventually(() => harness.socket.destroyed);

    expect(harness.ready).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it("reports an authenticated but unsupported child version", async () => {
    const harness = await createHarness();

    await send(harness.socket, readyMessage(harness, "0.81.0"));
    await eventually(() => harness.errors.length >= 1);

    expect(harness.ready).toEqual([]);
    expect(harness.errors[0]?.message).toContain("Unsupported child protocol or Pi version 0.81.0");
  });

  it("requires ready to be the first message", async () => {
    const harness = await createHarness();

    await send(harness.socket, message(harness, { type: "tool", preview: "work" }));
    await eventually(() => harness.socket.destroyed);

    expect(harness.ready).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it("enforces the 64 KiB limit for ordinary messages", async () => {
    const accepted = await createHarness();
    await send(accepted.socket, paddedMessage(readyMessage(accepted), TELEMETRY_LIMIT));
    await eventually(() => accepted.ready.length === 1);

    const rejected = await createHarness();
    await send(rejected.socket, readyMessage(rejected));
    await eventually(() => rejected.ready.length === 1);
    await send(
      rejected.socket,
      paddedMessage(message(rejected, { type: "tool", preview: "work" }), TELEMETRY_LIMIT + 1),
    );
    await eventually(() => rejected.errors.length >= 1);

    expect(accepted.errors).toEqual([]);
    expect(rejected.errors[0]?.message).toBe("Bridge protocol error: Bridge tool message exceeds its size limit");
  });

  it("allows a final result up to 16 MiB", async () => {
    const harness = await createHarness();
    await send(harness.socket, readyMessage(harness));
    await eventually(() => harness.ready.length === 1);
    const result = paddedMessage(message(harness, { type: "result", status: "completed", output: "" }), RESULT_LIMIT);

    await send(harness.socket, result);
    await eventually(() => harness.results.length === 1);

    expect(harness.results[0]?.status).toBe("completed");
    expect(harness.results[0]?.output).toBe("");
    expect(harness.errors).toEqual([]);
  });

  it("rejects decreasing turn and token counters", async () => {
    const harness = await createHarness();
    await send(harness.socket, readyMessage(harness));
    await send(harness.socket, message(harness, { type: "turn", turns: 2, tokens: { input: 10, output: 20 } }));
    await eventually(() => harness.turns.length === 1);
    await send(harness.socket, message(harness, { type: "turn", turns: 1, tokens: { input: 11, output: 21 } }));
    await eventually(() => harness.errors.length >= 1);

    expect(harness.turns).toEqual([{ turns: 2, tokens: { input: 10, output: 20 } }]);
    expect(harness.errors[0]?.message).toBe("Bridge protocol error: Invalid or decreasing bridge counters");
  });

  it.each([
    ["completed", { status: "completed", output: "done" }],
    ["failed", { status: "failed", output: "partial", error: "provider failed" }],
    ["failed with an empty error", { status: "failed", output: "partial", error: "" }],
    ["truncated", { status: "truncated", output: "cut short" }],
  ])("accepts the exact %s terminal result", async (_status, result) => {
    const harness = await createHarness();
    await send(harness.socket, readyMessage(harness));
    await send(harness.socket, message(harness, { type: "result", ...result }));
    await eventually(() => harness.results.length === 1);

    expect(harness.results).toEqual([result]);
    expect(harness.errors).toEqual([]);
  });

  it("keeps the first result and reports a duplicate result diagnostic", async () => {
    const harness = await createHarness();
    await send(harness.socket, readyMessage(harness));
    await send(harness.socket, message(harness, { type: "result", status: "completed", output: "first" }));
    await eventually(() => harness.results.length === 1);
    await send(harness.socket, message(harness, { type: "result", status: "completed", output: "second" }));
    await eventually(() => harness.errors.length >= 1);

    expect(harness.results).toEqual([{ status: "completed", output: "first" }]);
    expect(harness.errors[0]?.message).toBe("Bridge protocol error: Duplicate bridge result message");
  });

  it("rejects later extra client connections without failing the authenticated bridge", async () => {
    const harness = await createHarness();
    await send(harness.socket, readyMessage(harness));
    await eventually(() => harness.ready.length === 1);
    const extra = new Socket();
    extra.on("error", () => {});
    extra.connect(harness.manifest.socketPath);
    await once(extra, "connect");
    await once(extra, "close");

    expect(harness.errors).toEqual([]);
  });

  it("closes idempotently", async () => {
    const harness = await createHarness();

    await harness.bridge.close();
    await harness.bridge.close();

    expect(harness.socket.destroyed).toBe(true);
  });
});
