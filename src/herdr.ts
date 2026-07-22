import { spawn } from "node:child_process";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { HerdrStatus } from "./types.js";

export const HERDR_VERSION = "0.7.5";

const HerdrResponseSchema = Type.Record(Type.String(), Type.Unknown());
const HerdrEnvelopeSchema = Type.Object({
  id: Type.Optional(Type.String()),
  result: Type.Optional(HerdrResponseSchema),
  error: Type.Optional(Type.Object({ code: Type.Optional(Type.String()), message: Type.Optional(Type.String()) })),
});
const TabInfoSchema = Type.Object({
  type: Type.Literal("tab_info"),
  tab: Type.Object({
    tab_id: Type.String(),
    workspace_id: Type.String(),
    label: Type.Optional(Type.String()),
  }),
});
const TabCreatedSchema = Type.Object({
  type: Type.Literal("tab_created"),
  tab: Type.Object({ tab_id: Type.String(), workspace_id: Type.String(), label: Type.String() }),
  root_pane: Type.Object({ pane_id: Type.String(), tab_id: Type.String(), workspace_id: Type.String() }),
});
const AgentStartedSchema = Type.Object({ type: Type.Literal("agent_started") });
const AgentPromptedSchema = Type.Object({ type: Type.Literal("agent_prompted") });
const AgentInfoSchema = Type.Object({
  type: Type.Literal("agent_info"),
  agent: Type.Object({
    agent_status: Type.Union([
      Type.Literal("idle"),
      Type.Literal("working"),
      Type.Literal("blocked"),
      Type.Literal("done"),
      Type.Literal("unknown"),
    ]),
  }),
});

const herdrEnvelope = Compile(HerdrEnvelopeSchema);
const tabInfo = Compile(TabInfoSchema);
const tabCreated = Compile(TabCreatedSchema);
const agentInfo = Compile(AgentInfoSchema);
const agentStarted = Compile(AgentStartedSchema);
const agentPrompted = Compile(AgentPromptedSchema);

export type HerdrResponse = Static<typeof HerdrResponseSchema>;

export interface HerdrTab {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly label?: string;
}

export interface HerdrCreatedTab {
  readonly tab: HerdrTab & { readonly label: string };
  readonly rootPane: { readonly paneId: string; readonly tabId: string; readonly workspaceId: string };
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error(`${command} command aborted`));
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.timeout !== undefined) timer = setTimeout(abort, options.timeout);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) return reject(new Error(`${command} command aborted`));
      if (signal && code === null) return reject(new Error(`${command} command terminated by ${signal}`));
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });

export class HerdrCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    throw new Error(`Invalid JSON response: ${text.trim() || "<empty>"}`);
  }
}

export async function herdr(
  args: readonly string[],
  options: { signal?: AbortSignal; timeout?: number; runner?: CommandRunner } = {},
): Promise<HerdrResponse> {
  const result = await (options.runner ?? runCommand)("herdr", args, options);
  const value = parseJson(result.code === 0 ? result.stdout : result.stderr || result.stdout);
  if (!herdrEnvelope.Check(value)) throw new Error("Malformed Herdr response envelope");
  if (result.code !== 0 || value.error) {
    throw new HerdrCommandError(
      value.error?.code ?? `exit_${result.code}`,
      value.error?.message ?? `herdr ${args.join(" ")} failed`,
    );
  }
  if (!value.result) throw new Error("Herdr response has no result object");
  return value.result;
}

export async function herdrVersion(runner: CommandRunner = runCommand): Promise<string | undefined> {
  const result = await runner("herdr", ["--version"], { timeout: 5_000 });
  if (result.code !== 0) return undefined;
  return result.stdout.trim().replace(/^herdr\s+/, "") || undefined;
}

export function parseTabInfo(response: HerdrResponse): HerdrTab | undefined {
  if (!tabInfo.Check(response)) return undefined;
  return {
    tabId: response.tab.tab_id,
    workspaceId: response.tab.workspace_id,
    ...(response.tab.label === undefined ? {} : { label: response.tab.label }),
  };
}

export function parseTabCreated(response: HerdrResponse): HerdrCreatedTab | undefined {
  if (!tabCreated.Check(response)) return undefined;
  return {
    tab: { tabId: response.tab.tab_id, workspaceId: response.tab.workspace_id, label: response.tab.label },
    rootPane: {
      paneId: response.root_pane.pane_id,
      tabId: response.root_pane.tab_id,
      workspaceId: response.root_pane.workspace_id,
    },
  };
}

export function assertAgentStarted(response: HerdrResponse): void {
  if (!agentStarted.Check(response)) throw new Error("Malformed Herdr agent start response");
}

export function assertAgentPrompted(response: HerdrResponse): void {
  if (!agentPrompted.Check(response)) throw new Error("Malformed Herdr agent prompt response");
}

export function parseAgentStatus(response: HerdrResponse): HerdrStatus | undefined {
  return agentInfo.Check(response) ? response.agent.agent_status : undefined;
}
