import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ImpSettings } from "./types.js";

const DEFAULTS: ImpSettings = {
  turnLimit: 30,
  toolAllowlist: undefined,
  modelPatterns: undefined,
};

function policyArray(name: string, value: unknown, allowEmptyStrings: boolean): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || (!allowEmptyStrings && item.length === 0))
  ) {
    throw new Error(`${name} must be an array of ${allowEmptyStrings ? "strings" : "non-empty strings"}`);
  }
  const strings = value as string[];
  if (name === "toolAllowlist" && strings.some((tool) => tool.includes(",") || tool.includes("\0"))) {
    throw new Error("toolAllowlist entries must not contain commas or NUL bytes");
  }
  return strings;
}

export function parseImpSettings(block: Record<string, unknown> | undefined): ImpSettings {
  if (!block || typeof block !== "object") return { ...DEFAULTS };
  return {
    turnLimit:
      typeof block.turnLimit === "number" && Number.isInteger(block.turnLimit) && block.turnLimit >= 2
        ? block.turnLimit
        : DEFAULTS.turnLimit,
    toolAllowlist: Object.hasOwn(block, "toolAllowlist")
      ? policyArray("toolAllowlist", block.toolAllowlist, false)
      : undefined,
    modelPatterns: Object.hasOwn(block, "modelPatterns")
      ? policyArray("modelPatterns", block.modelPatterns, true)
      : undefined,
  };
}

export function loadImpSettings(agentDir = getAgentDir()): ImpSettings {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, "imps.json"), "utf8"));
    return parseImpSettings(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULTS };
    }
    throw error;
  }
}
