import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeServer, RESULT_LIMIT, TELEMETRY_LIMIT } from "../src/bridge.js";
import type { TerminalResult } from "../src/types.js";

const bridges: BridgeServer[] = [];
const dirs: string[] = [];

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

async function harness() {
  const runtimeDir = await mkdtemp(join(tmpdir(), "pi-goblins-bridge-"));
  dirs.push(runtimeDir);
  const manifest = { socketPath: join(runtimeDir, "bridge.sock"), turnLimit: 30 };
  const connected: number[] = [];
  const tools: string[] = [];
  const turns: unknown[] = [];
  const results: TerminalResult[] = [];
  const errors: Error[] = [];
  const bridge = new BridgeServer(manifest, {
    onConnect: () => connected.push(1),
    onTool: (value) => tools.push(value),
    onTurn: (count, tokens) => turns.push({ count, tokens }),
    onResult: (result) => results.push(result),
    onError: (error) => errors.push(error),
  });
  bridges.push(bridge);
  await bridge.listen(runtimeDir);
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => socket.once("error", reject).connect(manifest.socketPath, resolve));
  await eventually(() => connected.length === 1);
  return { manifest, socket, connected, tools, turns, results, errors };
}

function send(socket: Socket, event: unknown | string): Promise<void> {
  const value = typeof event === "string" ? event : JSON.stringify(event);
  return new Promise((resolve, reject) => socket.write(`${value}\n`, (error) => (error ? reject(error) : resolve())));
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("BridgeServer", () => {
  it("treats connection as readiness and gives the first connection ownership", async () => {
    const h = await harness();
    const extra = new Socket();
    let closed = false;
    extra.on("close", () => (closed = true));
    extra.connect(h.manifest.socketPath);
    await eventually(() => closed);
    expect(h.connected).toHaveLength(1);
  });

  it("delivers telemetry and enforces monotonic counters", async () => {
    const h = await harness();
    await send(h.socket, { type: "tool", preview: "→ read x" });
    await send(h.socket, { type: "turn", turns: 2, tokens: { input: 10, output: 3 } });
    await eventually(() => h.turns.length === 1);
    expect(h.tools).toEqual(["→ read x"]);
    await send(h.socket, { type: "turn", turns: 1, tokens: { input: 10, output: 3 } });
    await eventually(() => h.errors.length === 1);
    expect(h.errors[0]?.message).toContain("decreasing bridge counters");
  });

  it.each<TerminalResult>([
    { status: "completed", output: "done" },
    { status: "failed", output: "partial", error: "provider" },
    { status: "truncated", output: "final" },
  ])("preserves an exact $status result", async (result) => {
    const h = await harness();
    await send(h.socket, { type: "result", ...result });
    await eventually(() => h.results.length === 1);
    expect(h.results[0]).toEqual(result);
    h.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.errors).toEqual([]);
  });

  it("fails disconnect before a result", async () => {
    const h = await harness();
    h.socket.destroy();
    await eventually(() => h.errors.length === 1);
    expect(h.errors[0]?.message).toBe("Bridge disconnected before result");
  });

  it("rejects malformed UTF-8, oversized telemetry, and oversized results", async () => {
    const malformed = await harness();
    malformed.socket.write(Buffer.from([0xff, 0x0a]));
    await eventually(() => malformed.errors.length === 1);
    expect(malformed.errors[0]?.message).toContain("Bridge protocol error");

    const telemetry = await harness();
    await send(telemetry.socket, JSON.stringify({ type: "tool", preview: "x" }).padEnd(TELEMETRY_LIMIT + 1, " "));
    await eventually(() => telemetry.errors.length === 1);
    expect(telemetry.errors[0]?.message).toContain("size limit");

    const result = await harness();
    result.socket.write(Buffer.alloc(RESULT_LIMIT + 1, 0x20));
    await eventually(() => result.errors.length === 1);
    expect(result.errors[0]?.message).toContain("exceeds 16 MiB");
  });

  it("keeps the first result immutable", async () => {
    const h = await harness();
    await send(h.socket, { type: "result", status: "completed", output: "first" });
    await send(h.socket, { type: "result", status: "completed", output: "second" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.results).toEqual([{ status: "completed", output: "first" }]);
  });
});
