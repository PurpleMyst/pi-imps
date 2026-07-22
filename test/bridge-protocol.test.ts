import { describe, expect, it } from "vitest";
import { parseBridgeMessage, parseChildManifest } from "../src/bridge-protocol.js";

const identity = { ownerId: "owner", launchId: "launch" };

describe("bridge protocol schemas", () => {
  it("accepts each valid terminal result shape", () => {
    expect(parseBridgeMessage({ ...identity, type: "result", status: "completed", output: "done" })).toMatchObject({
      status: "completed",
    });
    expect(
      parseBridgeMessage({ ...identity, type: "result", status: "failed", output: "partial", error: "failed" }),
    ).toMatchObject({ status: "failed" });
    expect(parseBridgeMessage({ ...identity, type: "result", status: "truncated", output: "partial" })).toMatchObject({
      status: "truncated",
    });
  });

  it.each([
    null,
    { ...identity, type: "unknown" },
    { type: "tool", preview: "missing identity" },
    { ...identity, type: "turn", turns: -1, tokens: { input: 0, output: 0 } },
    { ...identity, type: "turn", turns: 1.5, tokens: { input: 0, output: 0 } },
    { ...identity, type: "turn", turns: 1, tokens: { input: Number.MAX_SAFE_INTEGER + 1, output: 0 } },
    { ...identity, type: "result", status: "failed", output: "partial" },
    { ...identity, type: "result", status: "completed", output: "done", error: "invalid" },
  ])("rejects malformed bridge input %#", (message) => {
    expect(() => parseBridgeMessage(message)).toThrow("Invalid bridge message");
  });

  it("validates child manifests at the file boundary", () => {
    const manifest = {
      protocol: 1,
      ownerId: "owner",
      launchId: "launch",
      nonce: "nonce",
      socketPath: "/tmp/bridge.sock",
      turnLimit: 3,
    };
    expect(parseChildManifest(manifest)).toEqual(manifest);
    expect(() => parseChildManifest({ ...manifest, protocol: 2 })).toThrow("Invalid child manifest");
    expect(() => parseChildManifest({ ...manifest, turnLimit: -1 })).toThrow("Invalid child manifest");
  });
});
