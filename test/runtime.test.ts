import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/herdr.js";
import { GoblinRuntime } from "../src/runtime.js";
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
  tabDelay?: number;
  duplicateResult?: boolean;
  busyStarts?: number;
  promptIdentityMismatch?: boolean;
  malformedTabCreation?: boolean;
  tabPaneCount?: number;
  stalledRefresh?: boolean;
}

async function setup(options: FakeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-goblins-runtime-"));
  roots.push(root);
  let socketPath = "";
  let manifestPath = "";
  let identity = { workspace_id: "w1", pane_id: "w1:p2", name: "" };
  const calls: string[][] = [];
  let starts = 0;
  let refreshAborted = false;
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
    if (args[0] === "workspace" && args[1] === "get")
      return envelope({ type: "workspace_info", workspace: { workspace_id: "w1", label: "parent" } });
    if (args[0] === "tab" && args[1] === "get" && args[2] === "w1:t1")
      return envelope({ type: "tab_info", tab: { tab_id: "w1:t1", workspace_id: "w1", label: "parent" } });
    if (args[0] === "pane" && args[1] === "get" && args[2] === "w1:p1")
      return envelope({ type: "pane_info", pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } });
    if (args[0] === "tab" && args[1] === "create") {
      if (options.tabDelay) await new Promise((resolve) => setTimeout(resolve, options.tabDelay));
      const manifestArg = args.find((arg) => arg.startsWith("PI_GOBLINS_MANIFEST="));
      if (!manifestArg) throw new Error("missing manifest");
      manifestPath = manifestArg.slice("PI_GOBLINS_MANIFEST=".length);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      socketPath = manifest.socketPath;
      const label = args[args.indexOf("--label") + 1];
      return envelope({
        type: "tab_created",
        tab: { tab_id: "w1:t2", workspace_id: "w1", label },
        root_pane: options.malformedTabCreation
          ? { pane_id: "w1:p2", tab_id: "w1:t2" }
          : { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
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
      const childSocketPath = socketPath;
      const childManifestPath = manifestPath;
      setTimeout(() => {
        const socket = connect(childSocketPath);
        socket.on("error", () => {});
        socket.on("connect", () => {
          void readFile(childManifestPath, "utf8").then((text) => {
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
    if (args[0] === "tab" && args[1] === "get" && args[2] === "w1:t2") {
      const create = calls.find((call) => call[1] === "tab" && call[2] === "create") ?? [];
      const label = create[create.indexOf("--label") + 1];
      return envelope({
        type: "tab_info",
        tab: { tab_id: "w1:t2", workspace_id: "w1", label, pane_count: options.tabPaneCount ?? 1 },
      });
    }
    if (args[0] === "pane" && args[1] === "get" && args[2] === "w1:p2")
      return envelope({ type: "pane_info", pane: { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" } });
    if (args[0] === "agent" && args[1] === "get") {
      if (options.stalledRefresh && commandOptions?.signal) {
        return new Promise((_, reject) => {
          commandOptions?.signal?.addEventListener(
            "abort",
            () => {
              refreshAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      }
      return envelope({ type: "agent_info", agent: { ...identity, agent_status: "idle" } });
    }
    return envelope({ type: "ok" });
  };
  const runtime = new GoblinRuntime({
    settings: { turnLimit: 30, toolAllowlist: undefined, modelPatterns: undefined },
    bridgePath: "/tmp/child-bridge.ts",
    parent: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
    runtimeRoot: root,
    runner,
  });
  const parent = model();
  const registry = { getAvailable: () => [parent] } as ModelRegistry;
  const prepare = (task = "perform a sufficiently detailed task") =>
    runtime.prepare({
      task,
      thinking: "medium",
      trusted: true,
      parentModel: parent,
      modelRegistry: registry,
    });
  const prepared = await prepare();
  return { runtime, prepared, prepare, calls, wasRefreshAborted: () => refreshAborted };
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

async function terminalSnapshot(runtime: GoblinRuntime, name: string) {
  await waitUntil(() => runtime.snapshots([name])[0]?.status !== "running");
  const snapshot = runtime.snapshots([name])[0];
  if (!snapshot) throw new Error(`Missing goblin snapshot: ${name}`);
  return snapshot;
}

describe("GoblinRuntime lifecycle", () => {
  it("coordinates exact bridge output with identity-matched prompt completion", async () => {
    const { runtime, prepared } = await setup({ result: { status: "completed", output: "a\n\nb" } });
    const name = runtime.summon(prepared, "/tmp");
    const terminal = await terminalSnapshot(runtime, name);
    expect(terminal.status).toBe("completed");
    expect(terminal.output).toBe("a\n\nb");
    expect(runtime.has(name)).toBe(true);
    const [claimed] = await runtime.wait("all", [name]);
    expect(claimed?.output).toBe("a\n\nb");
    expect(runtime.has(name)).toBe(false);
  });

  it("fails a malformed Herdr tab creation response", async () => {
    const { runtime, prepared } = await setup({ malformedTabCreation: true });
    const name = runtime.summon(prepared, "/tmp");
    const [result] = await runtime.wait("all", [name]);
    expect(result?.status).toBe("failed");
    expect(result?.error).toContain("Malformed or identity-mismatched Herdr tab creation response");
  });

  it("preserves partial output and provider error", async () => {
    const { runtime, prepared } = await setup({
      result: { status: "failed", output: "partial", error: "provider failed" },
    });
    const name = runtime.summon(prepared, "/tmp");
    const [result] = await runtime.wait("all", [name]);
    expect({ status: result?.status, output: result?.output, error: result?.error }).toEqual({
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
    const name = runtime.summon(prepared, "/tmp");
    const [result] = await runtime.wait("all", [name]);
    expect(result?.status).toBe("truncated");
    expect(result?.output).toBe("final allowed turn");
  });

  it("dismisses synchronously and claims before asynchronous cleanup", async () => {
    const { runtime, prepared, calls } = await setup({ promptDelay: 10_000 });
    const name = runtime.summon(prepared, "/tmp");
    await waitUntil(() => calls.some((call) => call[1] === "agent" && call[2] === "start"));
    expect(runtime.dismiss(name)).toEqual([name]);
    expect(runtime.has(name)).toBe(false);
    await runtime.shutdown();
  });

  it("keeps the first valid result when a duplicate arrives before prompt completion", async () => {
    const { runtime, prepared } = await setup({
      result: { status: "completed", output: "first" },
      duplicateResult: true,
      promptDelay: 30,
    });
    const name = runtime.summon(prepared, "/tmp");
    const [result] = await runtime.wait("all", [name]);
    expect({ status: result?.status, output: result?.output }).toEqual({ status: "completed", output: "first" });
  });

  it("retries agent_pane_busy and validates the eventual start", async () => {
    const { runtime, prepared, calls } = await setup({
      result: { status: "completed", output: "done" },
      busyStarts: 1,
    });
    const name = runtime.summon(prepared, "/tmp");
    expect((await runtime.wait("all", [name]))[0]?.status).toBe("completed");
    expect(calls.filter((call) => call[1] === "agent" && call[2] === "start")).toHaveLength(2);
  });

  it("fails a mismatched Herdr prompt identity", async () => {
    const { runtime, prepared } = await setup({
      result: { status: "completed", output: "untrusted" },
      promptIdentityMismatch: true,
    });
    const name = runtime.summon(prepared, "/tmp");
    const [result] = await runtime.wait("all", [name]);
    expect(result?.status).toBe("failed");
    expect(result?.error).toContain("prompt response identity mismatch");
  });

  it("waits for in-flight tab creation before aborting and closing it", async () => {
    const { runtime, prepared, calls } = await setup({ tabDelay: 30 });
    const name = runtime.summon(prepared, "/tmp");
    await waitUntil(() => calls.some((call) => call[1] === "tab" && call[2] === "create"));
    runtime.dismiss(name);
    await runtime.shutdown();
    expect(calls.some((call) => call[1] === "tab" && call[2] === "close")).toBe(true);
    expect(calls.some((call) => call[1] === "workspace" && call[2] === "close")).toBe(false);
  });

  it("closes only the goblin pane when its tab contains another pane", async () => {
    const { runtime, prepared, calls } = await setup({ promptDelay: 10_000, tabPaneCount: 2 });
    const name = runtime.summon(prepared, "/tmp");
    await waitUntil(() => calls.some((call) => call[1] === "agent" && call[2] === "start"));
    runtime.dismiss(name);
    await runtime.shutdown();
    expect(calls.some((call) => call[1] === "pane" && call[2] === "close")).toBe(true);
    expect(calls.some((call) => call[1] === "tab" && call[2] === "close")).toBe(false);
  });

  it("cancels an in-flight display refresh during dismissal", async () => {
    const { runtime, prepared, calls, wasRefreshAborted } = await setup({
      promptDelay: 10_000,
      stalledRefresh: true,
    });
    const name = runtime.summon(prepared, "/tmp");
    await waitUntil(() => calls.some((call) => call[1] === "agent" && call[2] === "start"));
    const refresh = runtime.refreshAll([name]);
    await waitUntil(() => calls.some((call) => call[1] === "agent" && call[2] === "get"));

    runtime.dismiss(name);

    await expect(refresh).resolves.toBeUndefined();
    expect(wasRefreshAborted()).toBe(true);
    await runtime.shutdown();
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
  it("allows only one concurrent waiter to claim a terminal goblin", async () => {
    const { runtime, prepared } = await setup({ result: { status: "completed", output: "winner" } });
    const name = runtime.summon(prepared, "/tmp");
    const tool = waitTool(runtime);
    const ctx = {} as ExtensionContext;
    const [a, b] = await Promise.all([
      tool.execute("a", { mode: "first" }, undefined, undefined, ctx),
      tool.execute("b", { mode: "first" }, undefined, undefined, ctx),
    ]);
    const lengths = [parseText(a), parseText(b)].map((value) => (value as unknown[]).length).sort();
    expect(lengths).toEqual([0, 1]);
    expect(runtime.has(name)).toBe(false);
  });

  it("an aborted wait claims nothing", async () => {
    const { runtime, prepared } = await setup({ result: { status: "completed", output: "later" }, resultDelay: 50 });
    const name = runtime.summon(prepared, "/tmp");
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
    await terminalSnapshot(runtime, name);
    expect(runtime.has(name)).toBe(true);
  });

  it("waits only for the requested names and leaves other results uncollected", async () => {
    const { runtime, prepared, prepare, calls } = await setup({
      result: { status: "completed", output: "filtered" },
    });
    const otherName = runtime.summon(prepared, "/tmp");
    await terminalSnapshot(runtime, otherName);
    await waitUntil(() => calls.some((call) => call[1] === "tab" && call[2] === "close"));

    const requestedName = runtime.summon(
      await prepare("perform a second sufficiently detailed task"),
      "/tmp",
    );
    const result = await waitTool(runtime).execute(
      "filtered",
      { mode: "all", names: [requestedName] },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(parseText(result)).toEqual([
      { name: requestedName, status: "completed", output: "filtered" },
    ]);
    expect(runtime.has(requestedName)).toBe(false);
    expect(runtime.has(otherName)).toBe(true);
    runtime.dismiss("all");
  });
});
