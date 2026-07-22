import type { Api, Model } from "@earendil-works/pi-ai";
import type { GoblinSettings, ThinkingLevel } from "./types.js";

const MAX_TASK_BYTES = 64 * 1024;
const MAX_SOCKET_PATH_BYTES = 103;
const EXCLUDED_TOOLS = ["summon", "wait", "dismiss", "list_goblins"] as const;

export function validateTask(task: string): void {
  if (task.includes("\0")) throw new Error("Task must not contain NUL bytes");
  if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) throw new Error("Task exceeds the 64 KiB UTF-8 limit");
}

export function validateRuntimePaths(runtimeDir: string, socketPath: string): void {
  if (!runtimeDir.startsWith("/") || !socketPath.startsWith("/"))
    throw new Error("Runtime and socket paths must be absolute");
  if (runtimeDir.includes("\0") || socketPath.includes("\0"))
    throw new Error("Runtime and socket paths must not contain NUL bytes");
  if (Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`Unix socket path exceeds ${MAX_SOCKET_PATH_BYTES} UTF-8 bytes`);
  }
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

export function isModelAllowed(canonical: string, patterns: string[] | undefined): boolean {
  return patterns === undefined || patterns.some((pattern) => globRegex(pattern).test(canonical));
}

function canonicalModel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function resolveModel(
  requested: string | undefined,
  parent: Model<Api> | undefined,
  available: Model<Api>[],
  patterns: string[] | undefined,
): { model: Model<Api>; canonical: string } {
  if (!requested) {
    if (!parent) throw new Error("No active parent model is available");
    const canonical = canonicalModel(parent);
    const candidate = available.find((model) => canonicalModel(model) === canonical);
    if (!candidate) throw new Error(`Active parent model "${canonical}" is not available`);
    if (!isModelAllowed(canonical, patterns)) throw new Error(`Model "${canonical}" is denied by modelPatterns`);
    return { model: candidate, canonical };
  }

  const tiers: Array<(candidate: Model<Api>) => boolean> = [
    (candidate) => canonicalModel(candidate) === requested,
    (candidate) => candidate.id === requested,
    (candidate) => candidate.name === requested,
  ];

  for (const matchesTier of tiers) {
    const raw = available.filter(matchesTier);
    if (raw.length === 0) continue;
    const allowed = raw.filter((candidate) => isModelAllowed(canonicalModel(candidate), patterns));
    if (allowed.length === 0) throw new Error(`Model "${requested}" is denied by modelPatterns`);
    const unique = new Map(allowed.map((candidate) => [canonicalModel(candidate), candidate]));
    if (unique.size > 1) {
      throw new Error(`Model "${requested}" is ambiguous: ${[...unique.keys()].join(", ")}`);
    }
    const [canonical, model] = unique.entries().next().value as [string, Model<Api>];
    return { model, canonical };
  }
  throw new Error(`Model "${requested}" is not available`);
}

export interface ChildSelection {
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly trusted: boolean;
  readonly tools: string[] | undefined;
}

export function buildPiArgs(selection: ChildSelection, bridgePath: string): string[] {
  const args = [
    "--no-session",
    "--model",
    selection.model,
    "--thinking",
    selection.thinking,
    "--extension",
    bridgePath,
    selection.trusted ? "--approve" : "--no-approve",
  ];
  if (selection.tools !== undefined) {
    if (selection.tools.length === 0) args.push("--no-tools");
    else args.push("--tools", selection.tools.join(","));
  }
  args.push("--exclude-tools", EXCLUDED_TOOLS.join(","));
  return args;
}

export function resolveTools(settings: GoblinSettings): string[] | undefined {
  return settings.toolAllowlist === undefined
    ? undefined
    : [...new Set(settings.toolAllowlist.filter((tool) => tool.length > 0 && !EXCLUDED_TOOLS.includes(tool as never)))];
}
