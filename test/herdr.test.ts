import { describe, expect, it } from "vitest";
import {
  assertAgentPrompted,
  assertAgentStarted,
  type CommandRunner,
  type HerdrCommandError,
  herdr,
  herdrVersion,
  parseAgentStatus,
  parseTabCreated,
  parseTabInfo,
} from "../src/herdr.js";

const result = (stdout: string, code = 0, stderr = "") => ({ stdout, stderr, code });
const envelope = (value: unknown) => JSON.stringify({ result: value });

describe("Herdr adapters", () => {
  it("parses command envelopes and structured errors", async () => {
    const runner: CommandRunner = async () => result(envelope({ type: "ok" }));
    await expect(herdr(["tab", "close", "t1"], { runner })).resolves.toEqual({ type: "ok" });
    const failing: CommandRunner = async () =>
      result("", 1, JSON.stringify({ error: { code: "missing", message: "gone" } }));
    await expect(herdr(["tab", "get", "t1"], { runner: failing })).rejects.toEqual(
      expect.objectContaining<Partial<HerdrCommandError>>({ code: "missing", message: "gone" }),
    );
  });

  it("optionally reads the client version", async () => {
    await expect(herdrVersion(async () => result("herdr 0.7.5\n"))).resolves.toBe("0.7.5");
    await expect(herdrVersion(async () => result("", 1))).resolves.toBeUndefined();
  });

  it("parses tab create/get responses", () => {
    expect(
      parseTabCreated({
        type: "tab_created",
        tab: { tab_id: "w:t2", workspace_id: "w", label: "pi-goblin-x" },
        root_pane: { pane_id: "w:p2", tab_id: "w:t2", workspace_id: "w" },
      }),
    ).toEqual({
      tab: { tabId: "w:t2", workspaceId: "w", label: "pi-goblin-x" },
      rootPane: { paneId: "w:p2", tabId: "w:t2", workspaceId: "w" },
    });
    expect(
      parseTabInfo({ type: "tab_info", tab: { tab_id: "w:t2", workspace_id: "w", label: "pi-goblin-x" } }),
    ).toEqual({ tabId: "w:t2", workspaceId: "w", label: "pi-goblin-x" });
    expect(parseTabInfo({ type: "wrong" })).toBeUndefined();
  });

  it("validates agent operation response kinds without identity checks", () => {
    expect(() => assertAgentStarted({ type: "agent_started", agent: { arbitrary: true } })).not.toThrow();
    expect(() => assertAgentPrompted({ type: "agent_prompted", agent: { arbitrary: true } })).not.toThrow();
    expect(() => assertAgentStarted({ type: "agent_prompted" })).toThrow("Malformed Herdr agent start response");
    expect(() => assertAgentPrompted({ type: "ok" })).toThrow("Malformed Herdr agent prompt response");
  });

  it.each(["idle", "working", "blocked", "done", "unknown"] as const)("parses %s agent status", (status) => {
    expect(parseAgentStatus({ type: "agent_info", agent: { agent_status: status } })).toBe(status);
  });
});
