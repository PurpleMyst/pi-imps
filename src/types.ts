import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = ModelThinkingLevel;
export type ResultStatus = "completed" | "failed" | "truncated";
export type GoblinStatus = "running" | ResultStatus | "dismissed";
export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface TerminalResult {
  readonly status: ResultStatus;
  readonly output: string;
  readonly error?: string;
}

export interface GoblinSnapshot {
  readonly name: string;
  readonly status: GoblinStatus;
  readonly turns: number;
  readonly tokens: { readonly input: number; readonly output: number };
  readonly output?: string;
  readonly error?: string;
  readonly activity?: string;
  readonly herdrStatus?: HerdrStatus;
}

export interface ParentHerdrContext {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
}

export interface OwnedTab {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly label: string;
  readonly agentName: string;
}


export interface GoblinSettings {
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

interface BridgeIdentity {
  readonly ownerId: string;
  readonly launchId: string;
}

export type BridgePayload =
  | { readonly type: "ready"; readonly protocol: 1; readonly nonce: string; readonly version: string }
  | { readonly type: "tool"; readonly preview: string }
  | {
      readonly type: "turn";
      readonly turns: number;
      readonly tokens: { readonly input: number; readonly output: number };
    }
  | ({ readonly type: "result" } & TerminalResult)
  | { readonly type: "error"; readonly error: string };

type WithIdentity<Payload> = Payload extends BridgePayload ? Payload & BridgeIdentity : never;

export type BridgeMessage = WithIdentity<BridgePayload>;
