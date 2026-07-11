import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ImpSnapshot } from "./types.js";

const SUMMON_TASK_PREVIEW_LINES = 3;
const SUMMON_TASK_PREVIEW_WIDTH = 96;
const SPINNER = "·•✧✦✧•";

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatAgentSuffix(agent: string | undefined, theme: Theme): string {
  if (!agent) return "";
  return ` the ${theme.fg("muted", agent)}`;
}

function formatStats(imp: ImpSnapshot, theme: Theme): string {
  const i = formatTokens(imp.tokens.input);
  const o = formatTokens(imp.tokens.output);
  return theme.fg("dim", `(${imp.turns}⟳ ${i}↓ ${o}↑)`);
}

/**
 * Format a single imp as a themed one-liner.
 *
 * Shows terse "✗ failed" for failures — full output is shown elsewhere in the TUI.
 */
export function formatImpStatusDisplay(imp: ImpSnapshot, theme: Theme, animationFrame: number): string {
  const name = theme.fg("accent", imp.name);
  const base = `${name}${formatAgentSuffix(imp.agent, theme)}`;
  const stats = formatStats(imp, theme);

  switch (imp.status) {
    case "running": {
      const frame = SPINNER[animationFrame % SPINNER.length];
      const activity = imp.activity ?? theme.fg("dim", "idle");
      return `${theme.fg("accent", frame)} ${base} ${stats}\n  ${activity}`;
    }
    case "completed":
      return `${theme.fg("success", "✓")} ${base} ${stats}`;
    case "failed":
      return `${theme.fg("error", "✗")} ${base}`;
    case "dismissed":
      return `${theme.fg("dim", "⊘")} ${base}`;
    case "truncated":
      return `${theme.fg("warning", "!")} ${base} ${stats}`;
    default:
      return `${base}: ${imp.status}`;
  }
}

/**
 * Format summon call for TUI display (themed).
 */
export function formatSummonCall(
  task: string | undefined,
  agent: string | undefined,
  model: string | undefined,
  thinking: string | undefined,
  expanded: boolean,
  expandHint: string,
  collapseHint: string,
  theme: Theme,
): string {
  const target = agent ? theme.fg("accent", agent) : theme.fg("muted", "ephemeral");
  const options = [model, thinking].filter((option): option is string => Boolean(option));
  const metadata = options.length > 0 ? theme.fg("muted", ` [${options.join(" · ")}]`) : "";
  const taskLines = wrapTextWithAnsi(task?.trim() || "...", SUMMON_TASK_PREVIEW_WIDTH);
  const visibleLines = expanded ? taskLines : taskLines.slice(0, SUMMON_TASK_PREVIEW_LINES);
  const prompt = visibleLines.map((line) => `  ${theme.fg("dim", line)}`).join("\n");
  const isTruncated = taskLines.length > SUMMON_TASK_PREVIEW_LINES;
  const hint =
    !expanded && isTruncated
      ? `\n  ${theme.fg("muted", `… ${taskLines.length - SUMMON_TASK_PREVIEW_LINES} more lines`)} (${expandHint})`
      : expanded && isTruncated
        ? `\n  ${theme.fg("muted", `(${collapseHint})`)}`
        : "";

  return `${theme.fg("toolTitle", theme.bold("summon"))} ${target}${metadata}\n${prompt}${hint}`;
}

/**
 * Format summon result for TUI display (themed).
 */
export function formatSummonDisplay(name: string, agent: string | undefined, theme: Theme): string {
  if (!agent) {
    return `${theme.fg("accent", name)} has answered your summons!`;
  }
  return `${theme.fg("accent", name)} the ${theme.fg("muted", agent)} has answered your summons!`;
}

/**
 * Format compact wait result for TUI display (themed).
 */
export function formatWaitDisplay(
  imps: ImpSnapshot[],
  mode: "all" | "first",
  theme: Theme,
  animationFrame = 0,
): string {
  if (imps.length === 0) return theme.fg("dim", "No uncollected imps.");

  const lines = imps.map((imp, i) => formatImpStatusDisplay(imp, theme, animationFrame + i));

  if (mode === "first") {
    const winner = imps[0];
    if (winner && winner.status !== "running") {
      const name = theme.fg("accent", winner.name);
      const agent = formatAgentSuffix(winner.agent, theme);
      return `${name}${agent} finished first ${formatStats(winner, theme)}`;
    }
  }

  return lines.join("\n");
}
