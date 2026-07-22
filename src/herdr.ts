import { spawn } from "node:child_process";
import { type Static, Type } from "typebox";
import Schema from "typebox/schema";
import type { HerdrStatus } from "./types.js";
import { assertPiVersion } from "./validation.js";

export { assertPiVersion } from "./validation.js";

export const HERDR_VERSION = "0.7.5";
export const HERDR_PROTOCOL = 17;
export const PI_INTEGRATION_VERSION = "v6";

const HerdrResponseSchema = Type.Record(Type.String(), Type.Unknown());
const HerdrEnvelopeSchema = Type.Object({
  id: Type.Optional(Type.String()),
  result: Type.Optional(HerdrResponseSchema),
  error: Type.Optional(
    Type.Object({
      code: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
    }),
  ),
});
const ServerStatusSchema = Type.Object({
  status: Type.String(),
  running: Type.Boolean(),
  version: Type.String(),
  protocol: Type.Number(),
  compatible: Type.Boolean(),
});
const WorkspaceInfoSchema = Type.Object({
  type: Type.Literal("workspace_info"),
  workspace: Type.Object({ workspace_id: Type.String() }),
});
const TabInfoSchema = Type.Object({
  type: Type.Literal("tab_info"),
  tab: Type.Object({
    tab_id: Type.String(),
    workspace_id: Type.String(),
    label: Type.Optional(Type.String()),
    pane_count: Type.Optional(Type.Number()),
  }),
});
const PaneInfoSchema = Type.Object({
  type: Type.Literal("pane_info"),
  pane: Type.Object({
    pane_id: Type.String(),
    tab_id: Type.String(),
    workspace_id: Type.String(),
  }),
});
const TabCreatedSchema = Type.Object({
  type: Type.Literal("tab_created"),
  tab: Type.Object({
    tab_id: Type.String(),
    workspace_id: Type.String(),
    label: Type.String(),
  }),
  root_pane: Type.Object({
    pane_id: Type.String(),
    tab_id: Type.String(),
    workspace_id: Type.String(),
  }),
});
const AgentSchema = {
  workspace_id: Type.String(),
  pane_id: Type.String(),
  name: Type.String(),
};
const AgentStartedSchema = Type.Object({
  type: Type.Literal("agent_started"),
  agent: Type.Object(AgentSchema),
});
const AgentPromptedSchema = Type.Object({
  type: Type.Literal("agent_prompted"),
  agent: Type.Object(AgentSchema),
});
const AgentInfoSchema = Type.Object({
  type: Type.Literal("agent_info"),
  agent: Type.Object({
    ...AgentSchema,
    agent_status: Type.Union([
      Type.Literal("idle"),
      Type.Literal("working"),
      Type.Literal("blocked"),
      Type.Literal("done"),
      Type.Literal("unknown"),
    ]),
  }),
});

const herdrEnvelope = Schema.Compile(HerdrEnvelopeSchema);
const serverStatus = Schema.Compile(ServerStatusSchema);
const workspaceInfo = Schema.Compile(WorkspaceInfoSchema);
const tabInfo = Schema.Compile(TabInfoSchema);
const paneInfo = Schema.Compile(PaneInfoSchema);
const tabCreated = Schema.Compile(TabCreatedSchema);
const agentStarted = Schema.Compile(AgentStartedSchema);
const agentPrompted = Schema.Compile(AgentPromptedSchema);
const agentInfo = Schema.Compile(AgentInfoSchema);

export type HerdrResponse = Static<typeof HerdrResponseSchema>;

export interface HerdrWorkspace {
  readonly workspaceId: string;
}

export interface HerdrTab {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly label?: string;
  readonly paneCount?: number;
}

export interface HerdrPane {
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
}

export interface HerdrAgent {
  readonly workspaceId: string;
  readonly paneId: string;
  readonly name: string;
}

export interface HerdrCreatedTab {
  readonly tab: HerdrTab & { readonly label: string };
  readonly rootPane: HerdrPane;
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
    const code = value.error?.code ?? `exit_${result.code}`;
    throw new HerdrCommandError(code, value.error?.message ?? `herdr ${args.join(" ")} failed`);
  }
  if (!value.result) throw new Error("Herdr response has no result object");
  return value.result;
}

export interface ServerStatus {
  readonly status: string;
  readonly running: boolean;
  readonly version: string;
  readonly protocol: number;
  readonly compatible: boolean;
}

export function parseServerStatus(text: string): ServerStatus {
  const value = parseJson(text);
  if (!serverStatus.Check(value)) throw new Error("Malformed Herdr server status");
  return {
    status: value.status,
    running: value.running,
    version: value.version,
    protocol: value.protocol,
    compatible: value.compatible,
  };
}

export function parseWorkspaceInfo(response: HerdrResponse): HerdrWorkspace | undefined {
  if (!workspaceInfo.Check(response)) return undefined;
  return { workspaceId: response.workspace.workspace_id };
}

export function parseTabInfo(response: HerdrResponse): HerdrTab | undefined {
  if (!tabInfo.Check(response)) return undefined;
  return {
    tabId: response.tab.tab_id,
    workspaceId: response.tab.workspace_id,
    ...(response.tab.label === undefined ? {} : { label: response.tab.label }),
    ...(response.tab.pane_count === undefined ? {} : { paneCount: response.tab.pane_count }),
  };
}

export function parsePaneInfo(response: HerdrResponse): HerdrPane | undefined {
  if (!paneInfo.Check(response)) return undefined;
  return {
    paneId: response.pane.pane_id,
    tabId: response.pane.tab_id,
    workspaceId: response.pane.workspace_id,
  };
}

export function parseTabCreated(response: HerdrResponse): HerdrCreatedTab | undefined {
  if (!tabCreated.Check(response)) return undefined;
  return {
    tab: {
      tabId: response.tab.tab_id,
      workspaceId: response.tab.workspace_id,
      label: response.tab.label,
    },
    rootPane: {
      paneId: response.root_pane.pane_id,
      tabId: response.root_pane.tab_id,
      workspaceId: response.root_pane.workspace_id,
    },
  };
}

function parsedAgent(response: {
  readonly agent: { readonly workspace_id: string; readonly pane_id: string; readonly name: string };
}): HerdrAgent {
  return {
    workspaceId: response.agent.workspace_id,
    paneId: response.agent.pane_id,
    name: response.agent.name,
  };
}

export function parseAgentStarted(response: HerdrResponse): HerdrAgent | undefined {
  return agentStarted.Check(response) ? parsedAgent(response) : undefined;
}

export function parseAgentPrompted(response: HerdrResponse): HerdrAgent | undefined {
  return agentPrompted.Check(response) ? parsedAgent(response) : undefined;
}

export function parseAgentInfo(
  response: HerdrResponse,
): (HerdrAgent & { readonly agentStatus: HerdrStatus }) | undefined {
  if (!agentInfo.Check(response)) return undefined;
  return { ...parsedAgent(response), agentStatus: response.agent.agent_status };
}

export function parsePiIntegration(text: string): { state: string; version?: string } {
  for (const line of text.split(/\r?\n/)) {
    const match = /^pi:\s+([^\s(]+)(?:\s+\((v\d+)\))?(?:\s+\(.+\))?\s*$/.exec(line);
    if (match) return { state: match[1] ?? "", version: match[2] };
  }
  throw new Error("Herdr integration status did not contain a valid pi entry");
}

export function shouldInvalidatePreflight(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /version|protocol|integration|server|connect|socket|unavailable|incompatible/i.test(
    `${error instanceof HerdrCommandError ? error.code : ""} ${error.message}`,
  );
}

export class Prerequisites {
  private success = false;
  private inFlight?: Promise<void>;
  private generation = 0;

  constructor(private readonly runner: CommandRunner = runCommand) {}

  invalidate(): void {
    this.success = false;
    this.generation++;
  }

  async check(): Promise<void> {
    if (this.success) return;
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    this.inFlight = this.run().then(() => {
      if (this.generation === generation) this.success = true;
    });
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async run(): Promise<void> {
    const version = await this.runner("herdr", ["--version"], { timeout: 5_000 });
    if (version.code !== 0 || version.stdout.trim() !== `herdr ${HERDR_VERSION}`) {
      throw new Error(`Herdr ${HERDR_VERSION} is required`);
    }
    const statusResult = await this.runner("herdr", ["status", "server", "--json"], { timeout: 5_000 });
    if (statusResult.code !== 0) throw new Error("Herdr server is unavailable");
    const status = parseServerStatus(statusResult.stdout);
    if (
      !status.running ||
      !status.compatible ||
      status.version !== HERDR_VERSION ||
      status.protocol !== HERDR_PROTOCOL
    ) {
      throw new Error(`Herdr server must be ${HERDR_VERSION} with protocol ${HERDR_PROTOCOL}`);
    }
    const integrationResult = await this.runner("herdr", ["integration", "status"], { timeout: 5_000 });
    const integration = parsePiIntegration(integrationResult.stdout);
    if (
      integrationResult.code !== 0 ||
      integration.state !== "current" ||
      integration.version !== PI_INTEGRATION_VERSION
    ) {
      throw new Error(`Pi integration ${PI_INTEGRATION_VERSION} is required; run: herdr integration install pi`);
    }
    const piVersion = await this.runner("pi", ["--version"], { timeout: 5_000 });
    if (piVersion.code !== 0) throw new Error("Pi is unavailable");
    assertPiVersion(piVersion.stdout);
  }
}
