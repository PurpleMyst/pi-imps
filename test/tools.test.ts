import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { GoblinRuntime, PrepareOptions } from "../src/runtime.js";
import { dismissTool, listGoblinsTool, summonTool } from "../src/tools.js";
import type { GoblinSnapshot } from "../src/types.js";

const context = {
  cwd: "/work",
  model: { provider: "test", id: "parent", name: "Parent" },
  modelRegistry: { getAvailable: () => [] },
  isProjectTrusted: () => true,
} as unknown as ExtensionContext;

function text(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

describe("summonTool", () => {
  it("passes the parent context through preparation and returns the allocated name", async () => {
    const prepared = { task: "perform a detailed task" };
    const prepare = vi.fn(async (_options: PrepareOptions) => prepared);
    const summon = vi.fn(() => "brindle");
    const runtime = { prepare, summon } as unknown as GoblinRuntime;

    const result = await summonTool(runtime, () => "medium").execute(
      "call",
      { task: prepared.task },
      undefined,
      undefined,
      context,
    );

    expect(prepare).toHaveBeenCalledWith({
      task: prepared.task,
      requestedModel: undefined,
      thinking: "medium",
      trusted: true,
      parentModel: context.model,
      modelRegistry: context.modelRegistry,
    });
    expect(summon).toHaveBeenCalledWith(prepared, "/work");
    expect(text(result)).toEqual({ name: "brindle" });
    expect(result.details).toEqual({ name: "brindle" });
  });
});

describe("dismissTool", () => {
  it("does not call dismiss for an unknown name", async () => {
    const dismiss = vi.fn();
    const runtime = { has: () => false, dismiss } as unknown as GoblinRuntime;
    const result = await dismissTool(runtime).execute("call", { name: "missing" }, undefined, undefined, context);

    expect(dismiss).not.toHaveBeenCalled();
    expect(result.details).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: "text", text: "No goblin found: missing" });
  });

  it("returns the names claimed by the runtime", async () => {
    const runtime = { has: () => true, dismiss: () => ["brindle"] } as unknown as GoblinRuntime;
    const result = await dismissTool(runtime).execute("call", { name: "brindle" }, undefined, undefined, context);

    expect(text(result)).toEqual({ dismissed: ["brindle"] });
    expect(result.details).toEqual({ names: ["brindle"] });
  });
});

describe("listGoblinsTool", () => {
  it("refreshes before returning the current snapshots", async () => {
    const goblins: GoblinSnapshot[] = [
      { name: "brindle", status: "running", turns: 2, tokens: { input: 3, output: 5 } },
    ];
    const refreshAll = vi.fn(async () => {});
    const runtime = { refreshAll, snapshots: () => goblins } as unknown as GoblinRuntime;

    const result = await listGoblinsTool(runtime).execute("call", {}, undefined, undefined, context);

    expect(refreshAll).toHaveBeenCalledOnce();
    expect(text(result)).toEqual([{ name: "brindle", status: "running" }]);
    expect(result.details).toBe(goblins);
  });
});
