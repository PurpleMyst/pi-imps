import { type AgentToolResult, keyHint, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatGoblinStatusDisplay, formatSummonCall, formatWaitDisplay } from "./display.js";
import type { GoblinRuntime } from "./runtime.js";
import type { GoblinSnapshot, ThinkingLevel } from "./types.js";

function goblinJson(goblin: GoblinSnapshot): Record<string, unknown> {
  return {
    name: goblin.name,
    status: goblin.status,
    ...(goblin.error !== undefined ? { error: goblin.error } : {}),
    ...(goblin.output !== undefined ? { output: goblin.output } : {}),
  };
}

const SummonParams = Type.Object({
  task: Type.String({ description: "What the goblin should do", minLength: 10 }),
  model: Type.Optional(Type.String({ description: "Model override for this goblin", minLength: 1 })),
  thinking: Type.Optional(
    Type.Union([
      Type.Literal("off"),
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
      Type.Literal("max"),
    ]),
  ),
});

export function summonTool(
  runtime: GoblinRuntime,
  getThinking: () => ThinkingLevel,
): ToolDefinition<typeof SummonParams, { name: string } | undefined> {
  return {
    name: "summon",
    label: "Summon Goblin",
    description:
      "Summon a goblin in a new tab of the parent Pi instance's Herdr workspace. Returns immediately after deterministic checks with a name; use wait to collect the result.",
    promptSnippet: "Summon a goblin for background task delegation",
    promptGuidelines: ["You can summon multiple goblins in parallel, then use wait with mode all or first."],
    parameters: SummonParams,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const prepared = await runtime.prepare({
          task: params.task,
          requestedModel: params.model,
          thinking: params.thinking ?? getThinking(),
          trusted: ctx.isProjectTrusted(),
          parentModel: ctx.model,
          modelRegistry: ctx.modelRegistry,
        });
        const name = runtime.summon(prepared, ctx.cwd);
        return {
          content: [{ type: "text", text: JSON.stringify({ name }) }],
          details: { name },
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Failed to summon: ${error instanceof Error ? error.message : String(error)}` },
          ],
          details: undefined,
        };
      }
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        formatSummonCall(
          args.task,
          args.model,
          args.thinking,
          context.expanded,
          keyHint("app.tools.expand", "to expand"),
          keyHint("app.tools.expand", "to collapse"),
          theme,
        ),
      );
      return text;
    },
    renderResult(result, _options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        result.details
          ? `${theme.fg("accent", result.details.name)} has answered your summons!`
          : result.content[0]?.type === "text"
            ? result.content[0].text
            : "",
      );
      return text;
    },
  };
}

const WaitParams = Type.Object({
  mode: Type.Union([Type.Literal("all"), Type.Literal("first")]),
  names: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});


export function waitTool(
  runtime: GoblinRuntime,
): ToolDefinition<typeof WaitParams, { goblins: GoblinSnapshot[] }, { animationFrame: number }> {
  return {
    name: "wait",
    label: "Wait for Goblins",
    description:
      "Block until goblins complete. all waits for every eligible goblin; first returns one claimed result without cancelling the others.",
    promptGuidelines: [
      "Collected goblins are removed. After wait(first), call wait again or dismiss remaining goblins.",
    ],
    parameters: WaitParams,
    async execute(_id, params, signal, onUpdate): Promise<AgentToolResult<{ goblins: GoblinSnapshot[] }>> {
      if (!runtime.hasEligible(params.names)) {
        return { content: [{ type: "text", text: "No uncollected goblins to wait for." }], details: { goblins: [] } };
      }
      const emit = () => {
        const snapshots = runtime.snapshots(params.names);
        void runtime.refreshAll(params.names);
        onUpdate?.({
          content: [{ type: "text", text: JSON.stringify(snapshots.map(goblinJson)) }],
          details: { goblins: snapshots },
        });
      };
      emit();
      const interval = setInterval(emit, 200);
      try {
        return thisResult(await runtime.wait(params.mode, params.names, signal));
      } finally {
        clearInterval(interval);
      }
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        `${theme.fg("toolTitle", theme.bold("wait"))} ${theme.fg("dim", args.mode === "first" ? "race" : "all")}`,
      );
      return text;
    },
    renderResult(result, _options, theme, context) {
      context.state.animationFrame = (context.state.animationFrame ?? 0) + 1;
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        formatWaitDisplay(
          result.details?.goblins ?? [],
          context.args?.mode ?? "all",
          theme,
          context.state.animationFrame,
        ),
      );
      return text;
    },
  };
}

function thisResult(goblins: GoblinSnapshot[]): AgentToolResult<{ goblins: GoblinSnapshot[] }> {
  return { content: [{ type: "text", text: JSON.stringify(goblins.map(goblinJson)) }], details: { goblins } };
}

const DismissParams = Type.Object({ name: Type.String({ minLength: 1 }) });

export function dismissTool(
  runtime: GoblinRuntime,
): ToolDefinition<typeof DismissParams, { names: string[] } | undefined> {
  return {
    name: "dismiss",
    label: "Dismiss Goblin",
    description: 'Dismiss a running or terminal uncollected goblin. Pass a goblin name or "all".',
    parameters: DismissParams,
    async execute(_id, params) {
      if (params.name !== "all" && !runtime.has(params.name)) {
        return { content: [{ type: "text", text: `No goblin found: ${params.name}` }], details: undefined };
      }
      const names = runtime.dismiss(params.name);
      return {
        content: [{ type: "text", text: JSON.stringify({ dismissed: names }) }],
        details: { names },
      };
    },
    renderResult(result, _options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        result.details?.names.length
          ? `${theme.fg("dim", "Dismissed ")}${result.details.names.map((name) => theme.fg("accent", name)).join(", ")}`
          : theme.fg("dim", result.content[0]?.type === "text" ? result.content[0].text : ""),
      );
      return text;
    },
  };
}

const ListParams = Type.Object({});

export function listGoblinsTool(runtime: GoblinRuntime): ToolDefinition<typeof ListParams, GoblinSnapshot[]> {
  return {
    name: "list_goblins",
    label: "List Goblins",
    description:
      "List running and recently completed goblins with current on-demand Herdr state and bridge statistics.",
    promptGuidelines: ["list_goblins shows status only; use wait to collect full results."],
    parameters: ListParams,
    async execute() {
      await runtime.refreshAll();
      const snapshots = runtime.snapshots();
      return { content: [{ type: "text", text: JSON.stringify(snapshots.map(goblinJson)) }], details: snapshots };
    },
    renderResult(result, _options, theme: Theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        result.details?.length
          ? result.details.map((goblin, index) => formatGoblinStatusDisplay(goblin, theme, index)).join("\n")
          : theme.fg("dim", "No goblins."),
      );
      return text;
    },
  };
}
