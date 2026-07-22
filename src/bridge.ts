import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { TextDecoder } from "node:util";
import { parseChildEvent } from "./bridge-protocol.js";
import type { ChildEvent, ChildManifest, TerminalResult } from "./types.js";
import { validateRuntimePaths } from "./validation.js";

export const TELEMETRY_LIMIT = 64 * 1024;
export const RESULT_LIMIT = 16 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface BridgeHandlers {
  readonly onConnect: () => void;
  readonly onTool: (preview: string) => void;
  readonly onTurn: (turns: number, tokens: { input: number; output: number }) => void;
  readonly onResult: (result: TerminalResult) => void;
  readonly onError: (error: Error) => void;
}

export class BridgeServer {
  private server?: Server;
  private socket?: Socket;
  private resultAccepted = false;
  private streamFailed = false;
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
    this.socket = socket;
    this.handlers.onConnect();
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) {
          if (buffered.length > RESULT_LIMIT) this.protocolError("Bridge message exceeds 16 MiB");
          break;
        }
        if (newline > RESULT_LIMIT) {
          this.protocolError("Bridge message exceeds 16 MiB");
          break;
        }
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        this.receive(line);
        if (socket.destroyed) break;
      }
    });
    socket.on("error", (error) => {
      if (!this.closing && !this.resultAccepted && !this.streamFailed) {
        this.streamFailed = true;
        this.handlers.onError(error);
      }
    });
    socket.on("close", () => {
      if (!this.closing && !this.resultAccepted && !this.streamFailed) {
        this.streamFailed = true;
        this.handlers.onError(new Error("Bridge disconnected before result"));
      }
    });
  }

  private receive(line: Buffer): void {
    try {
      const event = parseChildEvent(JSON.parse(decoder.decode(line)));
      const limit = event.type === "result" ? RESULT_LIMIT : TELEMETRY_LIMIT;
      if (line.length > limit) throw new Error(`Bridge ${event.type} message exceeds its size limit`);
      this.handle(event);
    } catch (error) {
      this.protocolError(error instanceof Error ? error.message : String(error));
    }
  }

  private handle(event: ChildEvent): void {
    switch (event.type) {
      case "tool":
        if (Buffer.byteLength(event.preview) > 512) throw new Error("Invalid tool preview");
        this.handlers.onTool(event.preview);
        break;
      case "turn":
        if (
          event.turns < this.turns ||
          event.tokens.input < this.tokens.input ||
          event.tokens.output < this.tokens.output
        ) {
          throw new Error("Invalid or decreasing bridge counters");
        }
        this.turns = event.turns;
        this.tokens = { ...event.tokens };
        this.handlers.onTurn(event.turns, event.tokens);
        break;
      case "result": {
        if (this.resultAccepted) throw new Error("Duplicate bridge result event");
        this.resultAccepted = true;
        const result: TerminalResult =
          event.status === "failed"
            ? { status: event.status, output: event.output, error: event.error }
            : { status: event.status, output: event.output };
        this.handlers.onResult(Object.freeze(result));
        break;
      }
    }
  }

  private protocolError(message: string): void {
    this.socket?.destroy();
    if (!this.resultAccepted && !this.streamFailed) {
      this.streamFailed = true;
      this.handlers.onError(new Error(`Bridge protocol error: ${message}`));
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.socket?.destroy();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = undefined;
    await rm(this.manifest.socketPath, { force: true });
  }
}
