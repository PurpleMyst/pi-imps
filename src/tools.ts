import { type AgentToolResult, keyHint, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatImpStatusDisplay, formatSummonCall, formatWaitDisplay } from "./display.js";
import type { ImpRuntime } from "./runtime.js";
import type { Imp, ImpSnapshot, ThinkingLevel } from "./types.js";

function impJson(imp: ImpSnapshot): Record<string, unknown> {
  return {
    name: imp.name,
    status: imp.status,
    ...(imp.error !== undefined ? { error: imp.error } : {}),
    ...(imp.output !== undefined ? { output: imp.output } : {}),
  };
}

const SummonParams = Type.Object({
  task: Type.String({ description: "What the imp should do", minLength: 10 }),
  model: Type.Optional(Type.String({ description: "Model override for this imp", minLength: 1 })),
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
  runtime: ImpRuntime,
  getThinking: () => ThinkingLevel,
): ToolDefinition<typeof SummonParams, { name: string } | undefined> {
  return {
    name: "summon",
    label: "Summon Imp",
    description:
      "Summon an imp in a Herdr-owned Pi workspace. Returns immediately after deterministic checks with a name; use wait to collect the result.",
    promptSnippet: "Summon an imp for background task delegation",
    promptGuidelines: ["You can summon multiple imps in parallel, then use wait with mode all or first."],
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
        const imp = runtime.summon(prepared, ctx.cwd);
        return {
          content: [{ type: "text", text: JSON.stringify({ name: imp.name }) }],
          details: { name: imp.name },
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

function aborted(signal: AbortSignal | undefined): Promise<"aborted"> | undefined {
  if (!signal) return undefined;
  return new Promise((resolve) => {
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

function eligible(runtime: ImpRuntime, names: Set<string> | undefined): Imp[] {
  return [...runtime.imps.values()].filter((imp) => !names || names.has(imp.name));
}

export function waitTool(
  runtime: ImpRuntime,
): ToolDefinition<typeof WaitParams, { imps: ImpSnapshot[] }, { animationFrame: number }> {
  return {
    name: "wait",
    label: "Wait for Imps",
    description:
      "Block until imps complete. all waits for every eligible imp; first returns one claimed result without cancelling the others.",
    promptGuidelines: ["Collected imps are removed. After wait(first), call wait again or dismiss remaining imps."],
    parameters: WaitParams,
    async execute(_id, params, signal, onUpdate): Promise<AgentToolResult<{ imps: ImpSnapshot[] }>> {
      const names = params.names ? new Set(params.names) : undefined;
      let waiting = eligible(runtime, names);
      if (waiting.length === 0) {
        return { content: [{ type: "text", text: "No uncollected imps to wait for." }], details: { imps: [] } };
      }
      const abortPromise = aborted(signal);
      const emit = () => {
        waiting = eligible(runtime, names);
        void runtime.refreshAll(waiting);
        onUpdate?.({
          content: [{ type: "text", text: JSON.stringify(waiting.map((imp) => impJson(imp))) }],
          details: { imps: runtime.snapshots().filter((snapshot) => !names || names.has(snapshot.name)) },
        });
      };
      emit();
      const interval = setInterval(emit, 200);
      try {
        const claimed: ImpSnapshot[] = [];
        if (params.mode === "all") {
          const outcome = await Promise.race([
            Promise.all(waiting.map((imp) => imp.done)).then(() => "done" as const),
            ...(abortPromise ? [abortPromise] : []),
          ]);
          if (outcome === "aborted" || signal?.aborted) return thisResult([]);
          for (const imp of waiting) {
            const snapshot = runtime.claim(imp);
            if (snapshot && snapshot.status !== "dismissed") claimed.push(snapshot);
          }
        } else {
          for (;;) {
            waiting = eligible(runtime, names);
            if (waiting.length === 0) break;
            const outcome = await Promise.race([
              ...waiting.map((imp) => imp.done.then(() => imp)),
              ...(abortPromise ? [abortPromise] : []),
            ]);
            if (outcome === "aborted" || signal?.aborted) return thisResult([]);
            const snapshot = runtime.claim(outcome as Imp);
            if (snapshot && snapshot.status !== "dismissed") {
              claimed.push(snapshot);
              break;
            }
          }
        }
        return thisResult(claimed);
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
        formatWaitDisplay(result.details?.imps ?? [], context.args?.mode ?? "all", theme, context.state.animationFrame),
      );
      return text;
    },
  };
}

function thisResult(imps: ImpSnapshot[]): AgentToolResult<{ imps: ImpSnapshot[] }> {
  return { content: [{ type: "text", text: JSON.stringify(imps.map(impJson)) }], details: { imps } };
}

const DismissParams = Type.Object({ name: Type.String({ minLength: 1 }) });

export function dismissTool(
  runtime: ImpRuntime,
): ToolDefinition<typeof DismissParams, { names: string[] } | undefined> {
  return {
    name: "dismiss",
    label: "Dismiss Imp",
    description: 'Dismiss a running or terminal uncollected imp. Pass an imp name or "all".',
    parameters: DismissParams,
    async execute(_id, params) {
      if (params.name !== "all" && !runtime.imps.has(params.name)) {
        return { content: [{ type: "text", text: `No imp found: ${params.name}` }], details: undefined };
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

export function listImpsTool(runtime: ImpRuntime): ToolDefinition<typeof ListParams, ImpSnapshot[]> {
  return {
    name: "list_imps",
    label: "List Imps",
    description: "List running and recently completed imps with current on-demand Herdr state and bridge statistics.",
    promptGuidelines: ["list_imps shows status only; use wait to collect full results."],
    parameters: ListParams,
    async execute() {
      await runtime.refreshAll();
      const snapshots = runtime.snapshots();
      return { content: [{ type: "text", text: JSON.stringify(snapshots.map(impJson)) }], details: snapshots };
    },
    renderResult(result, _options, theme: Theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        result.details?.length
          ? result.details.map((imp, index) => formatImpStatusDisplay(imp, theme, index)).join("\n")
          : theme.fg("dim", "No imps."),
      );
      return text;
    },
  };
}
