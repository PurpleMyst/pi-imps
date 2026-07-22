import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { GoblinSnapshot } from "./types.js";

const SPINNER = "·•✧✦✧•";

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function stats(goblin: GoblinSnapshot, theme: Theme): string {
  return theme.fg(
    "dim",
    `(${goblin.turns}⟳ ${formatTokens(goblin.tokens.input)}↓ ${formatTokens(goblin.tokens.output)}↑)`,
  );
}

export function formatGoblinStatusDisplay(goblin: GoblinSnapshot, theme: Theme, frame: number): string {
  const name = theme.fg("accent", goblin.name);
  switch (goblin.status) {
    case "running":
      return `${theme.fg("accent", SPINNER[frame % SPINNER.length] ?? "·")} ${name} ${stats(goblin, theme)}\n  ${goblin.activity ?? theme.fg("dim", goblin.herdrStatus ?? "starting")}`;
    case "completed":
      return `${theme.fg("success", "✓")} ${name} ${stats(goblin, theme)}`;
    case "failed":
      return `${theme.fg("error", "✗")} ${name}`;
    case "dismissed":
      return `${theme.fg("dim", "⊘")} ${name}`;
    case "truncated":
      return `${theme.fg("warning", "!")} ${name} ${stats(goblin, theme)}`;
  }
}

export function formatSummonCall(
  task: string | undefined,
  model: string | undefined,
  thinking: string | undefined,
  expanded: boolean,
  expandHint: string,
  collapseHint: string,
  theme: Theme,
): string {
  const options = [model, thinking].filter((value): value is string => Boolean(value));
  const metadata = options.length ? theme.fg("muted", ` [${options.join(" · ")}]`) : "";
  const lines = wrapTextWithAnsi(task?.trim() || "...", 96);
  const visible = expanded ? lines : lines.slice(0, 3);
  const hidden = lines.length - 3;
  const hint =
    hidden > 0
      ? `\n  ${theme.fg("muted", expanded ? `(${collapseHint})` : `… ${hidden} more lines (${expandHint})`)}`
      : "";
  return `${theme.fg("toolTitle", theme.bold("summon"))}${metadata}\n${visible.map((line) => `  ${theme.fg("dim", line)}`).join("\n")}${hint}`;
}

export function formatWaitDisplay(goblins: GoblinSnapshot[], mode: "all" | "first", theme: Theme, frame = 0): string {
  if (goblins.length === 0) return theme.fg("dim", "No uncollected goblins.");
  const winner = goblins[0];
  if (mode === "first" && winner && winner.status !== "running") {
    return `${theme.fg("accent", winner.name)} finished first ${stats(winner, theme)}`;
  }
  return goblins.map((goblin, index) => formatGoblinStatusDisplay(goblin, theme, frame + index)).join("\n");
}
