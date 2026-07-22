import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { TextDecoder } from "node:util";
import type { BridgeMessage, ChildManifest, TerminalResult } from "./types.js";
import { validateRuntimePaths } from "./validation.js";

export const TELEMETRY_LIMIT = 64 * 1024;
export const RESULT_LIMIT = 16 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface BridgeHandlers {
  readonly onReady: (version: string) => void;
  readonly onTool: (preview: string) => void;
  readonly onTurn: (turns: number, tokens: { input: number; output: number }) => void;
  readonly onResult: (result: TerminalResult) => void;
  readonly onError: (error: Error) => void;
}

function supportedPi(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return Boolean(match && Number(match[1]) === 0 && Number(match[2]) === 81 && Number(match[3]) >= 1);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class BridgeServer {
  private server?: Server;
  private socket?: Socket;
  private readonly candidates = new Set<Socket>();
  private ready = false;
  private resultAccepted = false;
  private closing = false;
  private turns = 0;
  private tokens = { input: 0, output: 0 };

  constructor(
    readonly manifest: ChildManifest,
    private readonly handlers: BridgeHandlers,
  ) {}

  async listen(runtimeDir: string): Promise<void> {
    validateRuntimePaths(runtimeDir, this.manifest.socketPath);
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await chmod(runtimeDir, 0o700);
    await rm(this.manifest.socketPath, { force: true });
    this.server = createServer((socket) => this.accept(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        const server = this.server;
        if (!server) return reject(new Error("Bridge server unavailable"));
        server.once("error", reject);
        server.listen(this.manifest.socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      await chmod(this.manifest.socketPath, 0o600);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private accept(socket: Socket): void {
    if (this.socket) {
      socket.destroy();
      return;
    }
    this.candidates.add(socket);
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) {
          if (buffered.length > RESULT_LIMIT) this.protocolError(socket, "Bridge message exceeds 16 MiB");
          break;
        }
        if (newline > RESULT_LIMIT) {
          this.protocolError(socket, "Bridge message exceeds 16 MiB");
          break;
        }
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        this.receive(socket, line);
        if (socket.destroyed) break;
      }
    });
    socket.on("error", (error) => {
      if (socket === this.socket && !this.closing) this.handlers.onError(error);
    });
    socket.on("close", () => {
      this.candidates.delete(socket);
      if (socket === this.socket && !this.closing)
        this.handlers.onError(new Error("Authenticated bridge disconnected"));
    });
  }

  private receive(socket: Socket, line: Buffer): void {
    let message: BridgeMessage;
    try {
      const text = decoder.decode(line);
      message = JSON.parse(text) as BridgeMessage;
      const limit = message.type === "result" ? RESULT_LIMIT : TELEMETRY_LIMIT;
      if (line.length > limit) throw new Error(`Bridge ${message.type} message exceeds its size limit`);
      this.validateIdentity(message);
      if (!this.socket && message.type !== "ready") throw new Error("The first bridge message must be ready");
      if (this.socket && socket !== this.socket)
        throw new Error("Message came from an unauthenticated bridge connection");
      switch (message.type) {
        case "ready":
          if (this.ready) throw new Error("Duplicate bridge ready message");
          if (message.protocol !== 1 || !supportedPi(message.version)) {
            this.protocolError(socket, `Unsupported child protocol or Pi version ${message.version}`, true);
            return;
          }
          this.ready = true;
          this.socket = socket;
          for (const candidate of this.candidates) if (candidate !== socket) candidate.destroy();
          this.candidates.clear();
          this.handlers.onReady(message.version);
          break;
        case "tool":
          if (typeof message.preview !== "string" || Buffer.byteLength(message.preview) > 512) {
            throw new Error("Invalid tool preview");
          }
          this.handlers.onTool(message.preview);
          break;
        case "turn":
          if (
            !nonnegativeInteger(message.turns) ||
            !nonnegativeInteger(message.tokens?.input) ||
            !nonnegativeInteger(message.tokens?.output) ||
            message.turns < this.turns ||
            message.tokens.input < this.tokens.input ||
            message.tokens.output < this.tokens.output
          ) {
            throw new Error("Invalid or decreasing bridge counters");
          }
          this.turns = message.turns;
          this.tokens = { ...message.tokens };
          this.handlers.onTurn(message.turns, message.tokens);
          break;
        case "result":
          if (this.resultAccepted) throw new Error("Duplicate bridge result message");
          if (
            !["completed", "failed", "truncated"].includes(message.status) ||
            typeof message.output !== "string" ||
            (message.status === "failed" ? typeof message.error !== "string" : message.error !== undefined)
          ) {
            throw new Error("Invalid bridge result invariants");
          }
          this.resultAccepted = true;
          this.handlers.onResult(
            Object.freeze({
              status: message.status,
              output: message.output,
              ...(message.error !== undefined ? { error: message.error } : {}),
            }),
          );
          break;
        case "error":
          if (typeof message.error !== "string") throw new Error("Invalid bridge error");
          this.handlers.onError(new Error(message.error));
          break;
        default:
          throw new Error(`Unknown bridge message type: ${String((message as { type?: unknown }).type)}`);
      }
    } catch (error) {
      this.protocolError(socket, error instanceof Error ? error.message : String(error));
    }
  }

  private validateIdentity(message: BridgeMessage): void {
    if (message.ownerId !== this.manifest.ownerId || message.launchId !== this.manifest.launchId) {
      throw new Error("Bridge identity mismatch");
    }
    if (message.type === "ready" && message.nonce !== this.manifest.nonce) throw new Error("Bridge nonce mismatch");
  }

  private protocolError(socket: Socket, message: string, report = false): void {
    const authenticated = socket === this.socket;
    socket.destroy();
    if (authenticated || report) this.handlers.onError(new Error(`Bridge protocol error: ${message}`));
  }

  async close(): Promise<void> {
    this.closing = true;
    this.socket?.destroy();
    for (const candidate of this.candidates) candidate.destroy();
    this.candidates.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = undefined;
    await rm(this.manifest.socketPath, { force: true });
  }
}
