import { spawn } from "node:child_process";

export const HERDR_VERSION = "0.7.5";
export const HERDR_PROTOCOL = 17;
export const PI_INTEGRATION_VERSION = "v6";

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

export interface HerdrEnvelope {
  readonly id?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: string; readonly message?: string };
}

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
): Promise<Record<string, unknown>> {
  const result = await (options.runner ?? runCommand)("herdr", args, options);
  const envelope = parseJson(result.code === 0 ? result.stdout : result.stderr || result.stdout) as HerdrEnvelope;
  if (result.code !== 0 || envelope.error) {
    const code = envelope.error?.code ?? `exit_${result.code}`;
    throw new HerdrCommandError(code, envelope.error?.message ?? `herdr ${args.join(" ")} failed`);
  }
  if (!envelope.result || typeof envelope.result !== "object") throw new Error("Herdr response has no result object");
  return envelope.result;
}

export interface ServerStatus {
  readonly status: string;
  readonly running: boolean;
  readonly version: string;
  readonly protocol: number;
  readonly compatible: boolean;
}

export function parseServerStatus(text: string): ServerStatus {
  const value = parseJson(text) as Partial<ServerStatus>;
  if (
    typeof value.status !== "string" ||
    typeof value.running !== "boolean" ||
    typeof value.version !== "string" ||
    typeof value.protocol !== "number" ||
    typeof value.compatible !== "boolean"
  ) {
    throw new Error("Malformed Herdr server status");
  }
  return value as ServerStatus;
}

export function parsePiIntegration(text: string): { state: string; version?: string } {
  for (const line of text.split(/\r?\n/)) {
    const match = /^pi:\s+([^\s(]+)(?:\s+\((v\d+)\))?(?:\s+\(.+\))?\s*$/.exec(line);
    if (match) return { state: match[1] ?? "", version: match[2] };
  }
  throw new Error("Herdr integration status did not contain a valid pi entry");
}

export function assertPiVersion(text: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!match || Number(match[1]) !== 0 || Number(match[2]) !== 81 || Number(match[3]) < 1) {
    throw new Error(`Pi ${text.trim()} is unsupported; require >=0.81.1 <0.82.0`);
  }
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
