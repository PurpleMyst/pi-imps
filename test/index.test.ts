import { afterEach, describe, expect, it } from "vitest";
import piGoblins from "../src/index.js";

const KEYS = ["PI_GOBLINS_CHILD", "HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fakePi() {
  const tools: string[] = [];
  const events: string[] = [];
  return {
    tools,
    events,
    api: {
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      on(event: string) {
        events.push(event);
      },
      getThinkingLevel() {
        return "medium";
      },
    },
  };
}

describe("pi-goblins registration", () => {
  it("registers nothing outside Herdr", () => {
    delete process.env.PI_GOBLINS_CHILD;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    const pi = fakePi();
    piGoblins(pi.api as never);
    expect(pi.tools).toEqual([]);
    expect(pi.events).toEqual([]);
  });

  it("registers nothing in a goblin child", () => {
    process.env.PI_GOBLINS_CHILD = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_TAB_ID = "w1:t1";
    process.env.HERDR_PANE_ID = "w1:p1";
    const pi = fakePi();
    piGoblins(pi.api as never);
    expect(pi.tools).toEqual([]);
    expect(pi.events).toEqual([]);
  });

  it("registers tools inside an identified Herdr pane", () => {
    delete process.env.PI_GOBLINS_CHILD;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_TAB_ID = "w1:t1";
    process.env.HERDR_PANE_ID = "w1:p1";
    const pi = fakePi();
    piGoblins(pi.api as never);
    expect(pi.tools).toEqual(["summon", "wait", "dismiss", "list_goblins"]);
    expect(pi.events).toContain("session_shutdown");
  });
});
