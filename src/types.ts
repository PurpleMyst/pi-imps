import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = ModelThinkingLevel;
export type ResultStatus = "completed" | "failed" | "truncated";
export type GoblinStatus = "running" | ResultStatus | "dismissed";
export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type { BridgeMessage, BridgePayload, ChildManifest, TerminalResult } from "./bridge-protocol.js";

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
