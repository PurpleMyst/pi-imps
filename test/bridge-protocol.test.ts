import { describe, expect, it } from "vitest";
import { parseChildEvent, parseChildManifest } from "../src/bridge-protocol.js";

describe("bridge protocol schemas", () => {
  it.each([
    { type: "tool", preview: "→ read file" },
    { type: "turn", turns: 2, tokens: { input: 10, output: 4 } },
    { type: "result", status: "completed", output: "done" },
    { type: "result", status: "failed", output: "partial", error: "provider failed" },
    { type: "result", status: "truncated", output: "final" },
  ])("accepts $type events", (event) => {
    expect(parseChildEvent(event)).toEqual(event);
  });

  it("requires errors only on failed results", () => {
    expect(() => parseChildEvent({ type: "result", status: "failed", output: "x" })).toThrow();
    expect(() => parseChildEvent({ type: "result", status: "completed", output: "x", error: "no" })).toThrow();
  });

  it("rejects unsafe or negative counters", () => {
    expect(() => parseChildEvent({ type: "turn", turns: -1, tokens: { input: 0, output: 0 } })).toThrow();
    expect(() =>
      parseChildEvent({ type: "turn", turns: Number.MAX_SAFE_INTEGER + 1, tokens: { input: 0, output: 0 } }),
    ).toThrow();
  });

  it("accepts only the minimal manifest", () => {
    const manifest = { socketPath: "/tmp/g/bridge.sock", turnLimit: 30 };
    expect(parseChildManifest(manifest)).toEqual(manifest);
    expect(() => parseChildManifest({ ...manifest, turnLimit: 1 })).toThrow("Invalid child manifest");
    expect(() => parseChildManifest({ ...manifest, turnLimit: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      "Invalid child manifest",
    );
  });
});
