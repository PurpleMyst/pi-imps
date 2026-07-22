import { describe, expect, it } from "vitest";
import {
  assertPiVersion,
  type CommandResult,
  type CommandRunner,
  HERDR_PROTOCOL,
  HERDR_VERSION,
  HerdrCommandError,
  herdr,
  PI_INTEGRATION_VERSION,
  Prerequisites,
  parseAgentInfo,
  parsePiIntegration,
  parseServerStatus,
  parseTabCreated,
  parseWorkspaceInfo,
  shouldInvalidatePreflight,
} from "../src/herdr.js";

const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", code: 0 });

function readyRunner(calls: string[][]): CommandRunner {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (command === "herdr" && args[0] === "--version") return ok(`herdr ${HERDR_VERSION}\n`);
    if (args[0] === "status") {
      return ok(
        JSON.stringify({
          status: "ready",
          running: true,
          version: HERDR_VERSION,
          protocol: HERDR_PROTOCOL,
          compatible: true,
        }),
      );
    }
    if (args[0] === "integration") return ok(`pi: current (${PI_INTEGRATION_VERSION}) (/opt/pi)\n`);
    return ok("0.81.1\n");
  };
}

describe("Herdr protocol parsing", () => {
  it("returns command results and surfaces protocol errors", async () => {
    await expect(herdr(["ping"], { runner: async () => ok('{"result":{"pong":true}}') })).resolves.toEqual({
      pong: true,
    });
    await expect(herdr(["ping"], { runner: async () => ok("{}") })).rejects.toThrow("no result object");
    await expect(
      herdr(["ping"], {
        runner: async () => ({ stdout: "", stderr: '{"error":{"code":"offline","message":"No server"}}', code: 1 }),
      }),
    ).rejects.toMatchObject({ code: "offline", message: "No server" } satisfies Partial<HerdrCommandError>);
    await expect(herdr(["ping"], { runner: async () => ok("not json") })).rejects.toThrow("Invalid JSON response");
  });

  it("validates wire responses and converts them to camelCase records", () => {
    expect(parseWorkspaceInfo({ type: "workspace_info", workspace: { workspace_id: "w1" } })).toEqual({
      workspaceId: "w1",
    });
    expect(
      parseTabCreated({
        type: "tab_created",
        tab: { tab_id: "w1:t2", workspace_id: "w1", label: "goblin" },
        root_pane: { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
      }),
    ).toEqual({
      tab: { tabId: "w1:t2", workspaceId: "w1", label: "goblin" },
      rootPane: { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" },
    });
    expect(
      parseAgentInfo({
        type: "agent_info",
        agent: { workspace_id: "w1", pane_id: "w1:p2", name: "goblin", agent_status: "working" },
      }),
    ).toEqual({ workspaceId: "w1", paneId: "w1:p2", name: "goblin", agentStatus: "working" });
    expect(
      parseTabCreated({
        type: "tab_created",
        tab: { tab_id: "w1:t2", workspace_id: "w1", label: "goblin" },
        root_pane: { pane_id: "w1:p2", tab_id: "w1:t2" },
      }),
    ).toBeUndefined();
    expect(
      parseAgentInfo({
        type: "agent_info",
        agent: { workspace_id: "w1", pane_id: "w1:p2", name: "goblin", agent_status: "unexpected" },
      }),
    ).toBeUndefined();
  });

  it("parses valid server and integration status including a trailing path", () => {
    expect(
      parseServerStatus('{"status":"ready","running":true,"version":"0.7.5","protocol":17,"compatible":true}'),
    ).toMatchObject({
      running: true,
      protocol: HERDR_PROTOCOL,
    });
    expect(() => parseServerStatus('{"status":"ready","running":"yes"}')).toThrow("Malformed Herdr server status");
    expect(parsePiIntegration(`other: stale\npi: current (${PI_INTEGRATION_VERSION}) (/opt/herdr/pi)\n`)).toEqual({
      state: "current",
      version: PI_INTEGRATION_VERSION,
    });
    expect(() => parsePiIntegration("pi: current at /opt/pi")).toThrow("valid pi entry");
  });

  it("enforces Pi's supported patch range", () => {
    expect(() => assertPiVersion("0.81.1")).not.toThrow();
    expect(() => assertPiVersion("0.81.99-dev")).not.toThrow();
    for (const version of ["0.81.0", "0.82.0", "1.81.1", "not-a-version"]) {
      expect(() => assertPiVersion(version)).toThrow(">=0.81.1 <0.82.0");
    }
  });
});

describe("Prerequisites", () => {
  it("caches a successful preflight and reruns it after invalidation", async () => {
    const calls: string[][] = [];
    const prerequisites = new Prerequisites(readyRunner(calls));

    await prerequisites.check();
    await prerequisites.check();
    expect(calls).toHaveLength(4);

    prerequisites.invalidate();
    await prerequisites.check();
    expect(calls).toHaveLength(8);
  });

  it("shares concurrent preflight callers and does not cache a failed preflight", async () => {
    const calls: string[][] = [];
    let releaseVersion!: () => void;
    const versionReady = new Promise<void>((resolve) => (releaseVersion = resolve));
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "herdr" && args[0] === "--version") {
        await versionReady;
        return ok(`herdr ${HERDR_VERSION}`);
      }
      if (args[0] === "status") {
        return ok(
          JSON.stringify({
            status: "ready",
            running: true,
            version: HERDR_VERSION,
            protocol: HERDR_PROTOCOL,
            compatible: true,
          }),
        );
      }
      if (args[0] === "integration") return ok(`pi: current (${PI_INTEGRATION_VERSION})`);
      return ok("0.81.1");
    };
    const prerequisites = new Prerequisites(runner);

    const first = prerequisites.check();
    const second = prerequisites.check();
    expect(calls).toEqual([["herdr", "--version"]]);
    releaseVersion();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(4);

    const failing = new Prerequisites(async () => ok("wrong version"));
    await expect(failing.check()).rejects.toThrow(`Herdr ${HERDR_VERSION} is required`);
    await expect(failing.check()).rejects.toThrow(`Herdr ${HERDR_VERSION} is required`);
  });

  it("identifies errors that require cached preflight invalidation", () => {
    expect(shouldInvalidatePreflight(new HerdrCommandError("agent_pane_busy", "pane is busy"))).toBe(false);
    expect(shouldInvalidatePreflight(new HerdrCommandError("server_unavailable", "cannot connect socket"))).toBe(true);
    expect(shouldInvalidatePreflight(new Error("protocol mismatch"))).toBe(true);
    expect(shouldInvalidatePreflight("server unavailable")).toBe(false);
  });
});
