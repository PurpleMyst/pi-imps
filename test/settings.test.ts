import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGoblinSettings } from "../src/settings.js";

const roots: string[] = [];

function agentDir(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-goblins-settings-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadGoblinSettings", () => {
  it("returns defaults when goblins.json is absent", () => {
    expect(loadGoblinSettings(agentDir())).toEqual({
      turnLimit: 50,
      toolAllowlist: undefined,
      modelPatterns: undefined,
    });
  });

  it("loads the supported settings", () => {
    const root = agentDir();
    writeFileSync(
      join(root, "goblins.json"),
      JSON.stringify({ turnLimit: 12, toolAllowlist: ["read"], modelPatterns: ["openai/*"] }),
    );

    expect(loadGoblinSettings(root)).toEqual({
      turnLimit: 12,
      toolAllowlist: ["read"],
      modelPatterns: ["openai/*"],
    });
  });

  it("propagates malformed JSON", () => {
    const root = agentDir();
    writeFileSync(join(root, "goblins.json"), "not json");
    expect(() => loadGoblinSettings(root)).toThrow(SyntaxError);
  });

  it("uses defaults for a non-object document", () => {
    const root = agentDir();
    writeFileSync(join(root, "goblins.json"), JSON.stringify(["unexpected"]));
    expect(loadGoblinSettings(root)).toEqual({
      turnLimit: 50,
      toolAllowlist: undefined,
      modelPatterns: undefined,
    });
  });
});
