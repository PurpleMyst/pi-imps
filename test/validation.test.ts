import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { parseGoblinSettings } from "../src/settings.js";
import {
  buildPiArgs,
  isModelAllowed,
  resolveModel,
  resolveTools,
  validateRuntimePaths,
  validateTask,
} from "../src/validation.js";

function model(provider: string, id: string, name = id): Model<Api> {
  return { provider, id, name } as Model<Api>;
}

const defaults = { turnLimit: 50, toolAllowlist: undefined, modelPatterns: undefined };

describe("settings policy", () => {
  it("distinguishes absent allowlists from explicit empty allowlists", () => {
    expect(parseGoblinSettings(undefined)).toEqual(defaults);
    expect(parseGoblinSettings({ turnLimit: 4 })).toEqual({ ...defaults, turnLimit: 4 });
    expect(parseGoblinSettings({ toolAllowlist: [], modelPatterns: [] })).toEqual({
      ...defaults,
      toolAllowlist: [],
      modelPatterns: [],
    });
    expect(parseGoblinSettings({ turnLimit: 1 })).toEqual(defaults);
    expect(parseGoblinSettings({ turnLimit: Number.MAX_SAFE_INTEGER + 1 })).toEqual(defaults);
  });

  it("fails closed for malformed policy arrays", () => {
    expect(() =>
      parseGoblinSettings({ turnLimit: 1.5, toolAllowlist: ["read", 1, "write"], modelPatterns: ["openai/*"] }),
    ).toThrow("toolAllowlist must be an array of non-empty strings");
    expect(() => parseGoblinSettings({ toolAllowlist: ["read,bash"] })).toThrow("must not contain commas");
    expect(() => parseGoblinSettings({ modelPatterns: "openai/*" })).toThrow("modelPatterns must be an array");
  });
});

describe("model policy", () => {
  it("uses case-sensitive whole-string globs", () => {
    expect(isModelAllowed("openai/gpt-5", ["openai/gpt-*"])).toBe(true);
    expect(isModelAllowed("OpenAI/gpt-5", ["openai/*"])).toBe(false);
    expect(isModelAllowed("prefix-openai/gpt-5", ["openai/*"])).toBe(false);
    expect(isModelAllowed("openai/gpt-5-extra", ["openai/gpt-?"])).toBe(false);
    expect(isModelAllowed("openai/gpt-5", undefined)).toBe(true);
  });

  it("resolves canonical names and aliases under the allowlist", () => {
    const alpha = model("provider", "alpha", "Alpha alias");
    const beta = model("provider", "beta", "Beta alias");
    expect(resolveModel("provider/alpha", undefined, [alpha, beta], ["provider/alpha"])).toEqual({
      model: alpha,
      canonical: "provider/alpha",
    });
    expect(resolveModel("beta", undefined, [alpha, beta], ["provider/*"])).toEqual({
      model: beta,
      canonical: "provider/beta",
    });
    expect(resolveModel("Alpha alias", undefined, [alpha, beta], ["provider/*"])).toEqual({
      model: alpha,
      canonical: "provider/alpha",
    });
  });

  it("denies a matching tier instead of falling through to a lower-priority alias", () => {
    const deniedId = model("denied", "shared", "Denied");
    const allowedAlias = model("allowed", "different", "shared");
    expect(() => resolveModel("shared", undefined, [deniedId, allowedAlias], ["allowed/*"])).toThrow(
      'Model "shared" is denied',
    );
  });

  it("reports ambiguity across canonical models but deduplicates registry duplicates", () => {
    const first = model("provider-a", "same", "Shared");
    const second = model("provider-b", "same", "Shared");
    expect(() => resolveModel("Shared", undefined, [first, second], undefined)).toThrow(
      'Model "Shared" is ambiguous: provider-a/same, provider-b/same',
    );

    const duplicate = model("provider-a", "same", "Shared");
    expect(resolveModel("Shared", undefined, [first, duplicate], undefined)).toEqual({
      model: duplicate,
      canonical: "provider-a/same",
    });
  });

  it("uses an available and authorized parent model when no override is requested", () => {
    const parent = model("parent", "active");
    expect(resolveModel(undefined, parent, [parent], ["parent/*"])).toEqual({
      model: parent,
      canonical: "parent/active",
    });
    expect(() => resolveModel(undefined, parent, [parent], ["other/*"])).toThrow('Model "parent/active" is denied');
    expect(() => resolveModel(undefined, parent, [], undefined)).toThrow("is not available");
    expect(() => resolveModel(undefined, undefined, [], undefined)).toThrow("No active parent model");
  });
});

describe("tool and child CLI policy", () => {
  it("preserves the allowlist tri-state and removes forbidden or duplicate tools", () => {
    expect(resolveTools({ ...defaults, toolAllowlist: undefined })).toBeUndefined();
    expect(resolveTools({ ...defaults, toolAllowlist: [] })).toEqual([]);
    expect(
      resolveTools({ ...defaults, toolAllowlist: ["read", "", "summon", "read", "list_goblins", "write"] }),
    ).toEqual(["read", "write"]);
  });

  it("renders approval and tool modes as Pi CLI arguments", () => {
    expect(
      buildPiArgs({ model: "provider/model", thinking: "high", trusted: true, tools: undefined }, "/bridge.ts"),
    ).toEqual([
      "--no-session",
      "--model",
      "provider/model",
      "--thinking",
      "high",
      "--extension",
      "/bridge.ts",
      "--approve",
      "--exclude-tools",
      "summon,wait,dismiss,list_goblins",
    ]);
    expect(
      buildPiArgs({ model: "provider/model", thinking: "off", trusted: false, tools: [] }, "/bridge.ts"),
    ).toContain("--no-tools");
    expect(
      buildPiArgs({ model: "provider/model", thinking: "off", trusted: false, tools: ["read", "write"] }, "/bridge.ts"),
    ).toEqual([
      "--no-session",
      "--model",
      "provider/model",
      "--thinking",
      "off",
      "--extension",
      "/bridge.ts",
      "--no-approve",
      "--tools",
      "read,write",
      "--exclude-tools",
      "summon,wait,dismiss,list_goblins",
    ]);
  });
});

describe("task and runtime path policy", () => {
  it("rejects NUL tasks and tasks over 64 KiB UTF-8 while accepting the boundary", () => {
    expect(() => validateTask("work\0now")).toThrow("must not contain NUL");
    expect(() => validateTask("é".repeat(32_768))).not.toThrow();
    expect(() => validateTask("é".repeat(32_769))).toThrow("64 KiB");
  });

  it("requires absolute NUL-free paths and enforces the socket byte limit", () => {
    expect(() => validateRuntimePaths("relative", "/tmp/bridge.sock")).toThrow("must be absolute");
    expect(() => validateRuntimePaths("/tmp/\0", "/tmp/bridge.sock")).toThrow("must not contain NUL");
    expect(() => validateRuntimePaths("/tmp/runtime", `/${"a".repeat(102)}`)).not.toThrow();
    expect(() => validateRuntimePaths("/tmp/runtime", `/${"a".repeat(103)}`)).toThrow("103 UTF-8 bytes");
  });
});
