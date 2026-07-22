import type { GoblinSnapshot, GoblinStatus, HerdrStatus, TerminalResult } from "./types.js";

const MISSING_RESULT_GRACE_MS = 1_000;

interface GoblinRecordOptions {
  readonly name: string;
  readonly task: string;
  readonly onTerminal: () => void;
}

export class GoblinRecord {
  readonly name: string;
  readonly task: string;
  readonly done: Promise<void>;

  private status: GoblinStatus = "running";
  private turns = 0;
  private tokens = { input: 0, output: 0 };
  private output?: string;
  private error?: string;
  private activity?: string;
  private herdrStatus?: HerdrStatus;
  private missingResultTimer?: ReturnType<typeof setTimeout>;
  private resolveDone!: () => void;
  private readonly onTerminal: () => void;

  constructor(options: GoblinRecordOptions) {
    this.name = options.name;
    this.task = options.task;
    this.onTerminal = options.onTerminal;
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  isRunning(): boolean {
    return this.status === "running";
  }

  snapshot(): GoblinSnapshot {
    return Object.freeze({
      name: this.name,
      status: this.status,
      turns: this.turns,
      tokens: Object.freeze({ ...this.tokens }),
      ...(this.output !== undefined ? { output: this.output } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
      ...(this.activity !== undefined ? { activity: this.activity } : {}),
      ...(this.herdrStatus !== undefined ? { herdrStatus: this.herdrStatus } : {}),
    });
  }

  updateActivity(activity: string): void {
    if (this.isRunning()) this.activity = activity;
  }

  updateTurn(turns: number, tokens: { readonly input: number; readonly output: number }): void {
    if (!this.isRunning()) return;
    this.turns = turns;
    this.tokens = { ...tokens };
  }

  updateHerdrStatus(status: HerdrStatus): void {
    if (this.isRunning()) this.herdrStatus = status;
  }

  acceptResult(result: TerminalResult): void {
    this.terminalize(result);
  }

  acceptPromptSuccess(): void {
    if (!this.isRunning() || this.missingResultTimer) return;
    this.missingResultTimer = setTimeout(
      () => this.fail(new Error("Child did not publish a result after the prompt completed")),
      MISSING_RESULT_GRACE_MS,
    );
  }

  fail(error: unknown): void {
    this.terminalize({
      status: "failed",
      output: "",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  dismiss(): boolean {
    return this.terminalize({ status: "dismissed" });
  }

  private terminalize(result: TerminalResult | { readonly status: "dismissed" }): boolean {
    if (!this.isRunning()) return false;
    if (this.missingResultTimer) clearTimeout(this.missingResultTimer);
    this.status = result.status;
    if (result.status !== "dismissed") this.output = result.output;
    if (result.status === "failed") this.error = result.error;
    this.resolveDone();
    this.onTerminal();
    return true;
  }
}
