import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = ModelThinkingLevel;
export type ResultStatus = "completed" | "failed" | "truncated";
export type ImpStatus = "running" | ResultStatus | "dismissed";
export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface TerminalResult {
  readonly status: ResultStatus;
  readonly output: string;
  readonly error?: string;
}

export interface ImpSnapshot {
  readonly name: string;
  readonly status: ImpStatus;
  readonly turns: number;
  readonly tokens: { readonly input: number; readonly output: number };
  readonly output?: string;
  readonly error?: string;
  readonly activity?: string;
  readonly herdrStatus?: HerdrStatus;
}

export interface OwnedWorkspace {
  readonly workspaceId: string;
  readonly paneId: string;
  readonly label: string;
  readonly agentName: string;
}

export interface Imp extends ImpSnapshot {
  readonly task: string;
  readonly launchId: string;
  readonly ownerId: string;
  readonly nonce: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly startedAt: number;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  readonly launchController: AbortController;
  status: ImpStatus;
  turns: number;
  tokens: { input: number; output: number };
  output?: string;
  error?: string;
  activity?: string;
  herdrStatus?: HerdrStatus;
  completedAt?: number;
  workspace?: OwnedWorkspace;
  bridgeReady?: boolean;
  bridgeResult?: TerminalResult;
  promptSucceeded?: boolean;
  coordinationTimer?: ReturnType<typeof setTimeout>;
  refreshPromise?: Promise<void>;
  refreshedAt?: number;
  workspaceCreateDone?: Promise<void>;
  launchPromise?: Promise<void>;
  cleanup?: Promise<void>;
}

export interface ImpSettings {
  readonly turnLimit: number;
  readonly toolAllowlist: string[] | undefined;
  readonly modelPatterns: string[] | undefined;
}

export interface ChildManifest {
  readonly protocol: 1;
  readonly ownerId: string;
  readonly launchId: string;
  readonly nonce: string;
  readonly socketPath: string;
  readonly turnLimit: number;
}

export interface BridgeReady {
  readonly type: "ready";
  readonly protocol: 1;
  readonly ownerId: string;
  readonly launchId: string;
  readonly nonce: string;
  readonly version: string;
}

export type BridgeMessage =
  | BridgeReady
  | { readonly type: "tool"; readonly ownerId: string; readonly launchId: string; readonly preview: string }
  | {
      readonly type: "turn";
      readonly ownerId: string;
      readonly launchId: string;
      readonly turns: number;
      readonly tokens: { readonly input: number; readonly output: number };
    }
  | ({ readonly type: "result"; readonly ownerId: string; readonly launchId: string } & TerminalResult)
  | { readonly type: "error"; readonly ownerId: string; readonly launchId: string; readonly error: string };
