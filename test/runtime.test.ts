import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/herdr.js";
import { ImpRuntime } from "../src/runtime.js";
import { waitTool } from "../src/tools.js";
import type { TerminalResult } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function envelope(result: Record<string, unknown>) {
  return { stdout: JSON.stringify({ id: "test", result }), stderr: "", code: 0 };
}

function model(id = "model", provider = "test"): Model<Api> {
  return { id, provider, name: id } as Model<Api>;
}

interface FakeOptions {
  result?: TerminalResult;
  promptDelay?: number;
  resultDelay?: number;
  workspaceDelay?: number;
  duplicateResult?: boolean;
  busyStarts?: number;
  promptIdentityMismatch?: boolean;
}

async function setup(options: FakeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-imps-runtime-"));
  roots.push(root);
  let socketPath = "";
  let identity = { workspace_id: "w1", pane_id: "w1:p1", name: "" };
  const calls: string[][] = [];
  let starts = 0;
  const runner: CommandRunner = async (command, args, commandOptions) => {
    calls.push([command, ...args]);
    if (command === "herdr" && args[0] === "--version") return { stdout: "herdr 0.7.5\n", stderr: "", code: 0 };
    if (command === "herdr" && args[0] === "status") {
      return {
        stdout: JSON.stringify({ status: "running", running: true, version: "0.7.5", protocol: 17, compatible: true }),
        stderr: "",
        code: 0,
      };
    }
    if (command === "herdr" && args[0] === "integration")
      return { stdout: "pi: current (v6) (/tmp/pi.ts)\n", stderr: "", code: 0 };
    if (command === "pi") return { stdout: "0.81.1\n", stderr: "", code: 0 };
    if (args[0] === "workspace" && args[1] === "create") {
      if (options.workspaceDelay) await new Promise((resolve) => setTimeout(resolve, options.workspaceDelay));
      const manifestArg = args.find((arg) => arg.startsWith("PI_IMPS_MANIFEST="));
      if (!manifestArg) throw new Error("missing manifest");
      const manifest = JSON.parse(await readFile(manifestArg.slice("PI_IMPS_MANIFEST=".length), "utf8"));
      socketPath = manifest.socketPath;
      const label = args[args.indexOf("--label") + 1];
      return envelope({
        type: "workspace_created",
        workspace: { workspace_id: "w1", label },
        root_pane: { pane_id: "w1:p1", workspace_id: "w1" },
      });
    }
    if (args[0] === "agent" && args[1] === "start") {
      if (commandOptions?.signal?.aborted) throw new Error("aborted");
      starts++;
      if (starts <= (options.busyStarts ?? 0)) {
        return {
          stdout: "",
          stderr: JSON.stringify({ error: { code: "agent_pane_busy", message: "busy" } }),
          code: 1,
        };
      }
      identity = { ...identity, name: args[2] ?? "" };
      setTimeout(() => {
        const socket = connect(socketPath);
        socket.on("error", () => {});
        socket.on("connect", () => {
          const manifestPath = calls
            .flat()
            .find((arg) => arg.startsWith("PI_IMPS_MANIFEST="))
            ?.slice("PI_IMPS_MANIFEST=".length);
          if (!manifestPath) throw new Error("manifest path not found");
          void readFile(manifestPath, "utf8").then((text) => {
            const manifest = JSON.parse(text);
            socket.write(
              `${JSON.stringify({ type: "ready", protocol: 1, ownerId: manifest.ownerId, launchId: manifest.launchId, nonce: manifest.nonce, version: "0.81.1" })}\n`,
            );
            if (options.result) {
              setTimeout(() => {
                socket.write(
                  `${JSON.stringify({ type: "result", ownerId: manifest.ownerId, launchId: manifest.launchId, ...options.result })}\n`,
                );
                if (options.duplicateResult) {
                  socket.write(
                    `${JSON.stringify({ type: "result", ownerId: manifest.ownerId, launchId: manifest.launchId, ...options.result, output: "duplicate" })}\n`,
                  );
                }
              }, options.resultDelay ?? 1);
            }
          });
        });
      }, 0);
      return envelope({ type: "agent_started", agent: identity, argv: [] });
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.promptDelay ?? 1);
        commandOptions?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
      return envelope({
        type: "agent_prompted",
        agent: options.promptIdentityMismatch ? { ...identity, pane_id: "wrong:pane" } : identity,
      });
    }
    if (args[0] === "workspace" && args[1] === "get") {
      const create = calls.find((call) => call[1] === "workspace" && call[2] === "create") ?? [];
      const label = create[create.indexOf("--label") + 1];
      return envelope({ type: "workspace_info", workspace: { workspace_id: "w1", label } });
    }
    if (args[0] === "agent" && args[1] === "get")
      return envelope({ type: "agent_info", agent: { ...identity, agent_status: "idle" } });
    return envelope({ type: "ok" });
  };
  const runtime = new ImpRuntime({
    settings: { turnLimit: 30, toolAllowlist: undefined, modelPatterns: undefined },
    bridgePath: "/tmp/child-bridge.ts",
    runtimeRoot: root,
    runner,
  });
  const parent = model();
  const registry = { getAvailable: () => [parent] } as ModelRegistry;
  const prepared = await runtime.prepare({
    task: "perform a sufficiently detailed task",
    thinking: "medium",
    trusted: true,
    parentModel: parent,
    modelRegistry: registry,
  });
  return { runtime, prepared, calls };
}

async function waitUntil(predicate: () => boolean, timeout = 1000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function parseText(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

describe("ImpRuntime lifecycle", () => {
  it("coordinates exact bridge output with identity-matched prompt completion", async () => {
    const { runtime, prepared } = await setup({ result: { status: "completed", output: "a\n\nb" } });
    const imp = runtime.summon(prepared, "/tmp");
    await imp.done;
    expect(imp.status).toBe("completed");
    expect(imp.output).toBe("a\n\nb");
    expect(runtime.imps.has(imp.name)).toBe(true);
    const snapshot = runtime.claim(imp);
    expect(snapshot?.output).toBe("a\n\nb");
    expect(runtime.imps.has(imp.name)).toBe(false);
  });

  it("preserves partial output and provider error", async () => {
    const { runtime, prepared } = await setup({
      result: { status: "failed", output: "partial", error: "provider failed" },
    });
    const imp = runtime.summon(prepared, "/tmp");
    await imp.done;
    expect({ status: imp.status, output: imp.output, error: imp.error }).toEqual({
      status: "failed",
      output: "partial",
      error: "provider failed",
    });
  });

  it("terminalizes truncated from the bridge without waiting for prompt settlement", async () => {
    const { runtime, prepared } = await setup({
      result: { status: "truncated", output: "final allowed turn" },
      promptDelay: 10_000,
    });
    const imp = runtime.summon(prepared, "/tmp");
    await imp.done;
    expect(imp.status).toBe("truncated");
    expect(imp.output).toBe("final allowed turn");
  });

  it("dismisses synchronously and claims before asynchronous cleanup", async () => {
    const { runtime, prepared } = await setup({ promptDelay: 10_000 });
    const imp = runtime.summon(prepared, "/tmp");
    await waitUntil(() => Boolean(imp.workspace));
    expect(runtime.dismiss(imp.name)).toEqual([imp.name]);
    expect(imp.status).toBe("dismissed");
    expect(runtime.imps.has(imp.name)).toBe(false);
    await expect(runtime.cleanup(imp)).resolves.toBeUndefined();
    await expect(runtime.cleanup(imp)).resolves.toBeUndefined();
  });

  it("keeps the first valid result when a duplicate arrives before prompt completion", async () => {
    const { runtime, prepared } = await setup({
      result: { status: "completed", output: "first" },
      duplicateResult: true,
      promptDelay: 30,
    });
    const imp = runtime.summon(prepared, "/tmp");
    await imp.done;
    expect({ status: imp.status, output: imp.output }).toEqual({ status: "completed", output: "first" });
  });

  it("retries agent_pane_busy and validates the eventual start", async () => {
    const { runtime, prepared, calls } = await setup({
      result: { status: "completed", output: "done" },
      busyStarts: 1,
    });
    const imp = runtime.summon(prepared, "/tmp");
    await imp.done;
    expect(imp.status).toBe("completed");
    expect(calls.filter((call) => call[1] === "agent" && call[2] === "start")).toHaveLength(2);
  });

  it("fails a mismatched Herdr prompt identity", async () => {
    const { runtime, prepared } = await setup({
      result: { status: "completed", output: "untrusted" },
      promptIdentityMismatch: true,
    });
    const imp = runtime.summon(prepared, "/tmp");
    await imp.done;
    expect(imp.status).toBe("failed");
    expect(imp.error).toContain("prompt response identity mismatch");
  });

  it("waits for in-flight workspace creation before aborting and closing it", async () => {
    const { runtime, prepared, calls } = await setup({ workspaceDelay: 30 });
    const imp = runtime.summon(prepared, "/tmp");
    await waitUntil(() => Boolean(imp.workspaceCreateDone));
    runtime.dismiss(imp.name);
    await runtime.cleanup(imp);
    expect(calls.some((call) => call[1] === "workspace" && call[2] === "close")).toBe(true);
  });

  it("memoizes shutdown without retaining the 65-second barrier after cleanup", async () => {
    const { runtime } = await setup();
    const started = Date.now();
    const shutdown = runtime.shutdown();
    expect(runtime.shutdown()).toBe(shutdown);
    await shutdown;
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("wait collection races", () => {
  it("allows only one concurrent waiter to claim a terminal imp", async () => {
    const { runtime, prepared } = await setup({ result: { status: "completed", output: "winner" } });
    const imp = runtime.summon(prepared, "/tmp");
    const tool = waitTool(runtime);
    const ctx = {} as ExtensionContext;
    const [a, b] = await Promise.all([
      tool.execute("a", { mode: "first" }, undefined, undefined, ctx),
      tool.execute("b", { mode: "first" }, undefined, undefined, ctx),
    ]);
    const lengths = [parseText(a), parseText(b)].map((value) => (value as unknown[]).length).sort();
    expect(lengths).toEqual([0, 1]);
    expect(runtime.imps.has(imp.name)).toBe(false);
  });

  it("an aborted wait claims nothing", async () => {
    const { runtime, prepared } = await setup({ result: { status: "completed", output: "later" }, resultDelay: 50 });
    const imp = runtime.summon(prepared, "/tmp");
    const controller = new AbortController();
    const pending = waitTool(runtime).execute(
      "a",
      { mode: "all" },
      controller.signal,
      undefined,
      {} as ExtensionContext,
    );
    controller.abort();
    expect(parseText(await pending)).toEqual([]);
    await imp.done;
    expect(runtime.imps.has(imp.name)).toBe(true);
  });
});
