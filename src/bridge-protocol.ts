import { type Static, Type } from "typebox";
import Schema from "typebox/schema";

const NonnegativeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Identity = {
  ownerId: Type.String(),
  launchId: Type.String(),
};

export const TerminalResultSchema = Type.Union([
  Type.Object({ status: Type.Literal("completed"), output: Type.String(), error: Type.Optional(Type.Never()) }),
  Type.Object({ status: Type.Literal("failed"), output: Type.String(), error: Type.String() }),
  Type.Object({ status: Type.Literal("truncated"), output: Type.String(), error: Type.Optional(Type.Never()) }),
]);

export const ChildManifestSchema = Type.Object({
  protocol: Type.Literal(1),
  ownerId: Type.String(),
  launchId: Type.String(),
  nonce: Type.String(),
  socketPath: Type.String(),
  turnLimit: NonnegativeInteger,
});

export const BridgeMessageSchema = Type.Union([
  Type.Object({
    ...Identity,
    type: Type.Literal("ready"),
    protocol: Type.Literal(1),
    nonce: Type.String(),
    version: Type.String(),
  }),
  Type.Object({ ...Identity, type: Type.Literal("tool"), preview: Type.String() }),
  Type.Object({
    ...Identity,
    type: Type.Literal("turn"),
    turns: NonnegativeInteger,
    tokens: Type.Object({ input: NonnegativeInteger, output: NonnegativeInteger }),
  }),
  Type.Object({
    ...Identity,
    type: Type.Literal("result"),
    status: Type.Literal("completed"),
    output: Type.String(),
    error: Type.Optional(Type.Never()),
  }),
  Type.Object({
    ...Identity,
    type: Type.Literal("result"),
    status: Type.Literal("failed"),
    output: Type.String(),
    error: Type.String(),
  }),
  Type.Object({
    ...Identity,
    type: Type.Literal("result"),
    status: Type.Literal("truncated"),
    output: Type.String(),
    error: Type.Optional(Type.Never()),
  }),
  Type.Object({ ...Identity, type: Type.Literal("error"), error: Type.String() }),
]);

const bridgeMessage = Schema.Compile(BridgeMessageSchema);
const childManifest = Schema.Compile(ChildManifestSchema);

export type TerminalResult = Static<typeof TerminalResultSchema>;
export type ChildManifest = Static<typeof ChildManifestSchema>;
export type BridgeMessage = Static<typeof BridgeMessageSchema>;
type WithoutIdentity<Message> = Message extends BridgeMessage ? Omit<Message, "ownerId" | "launchId"> : never;
export type BridgePayload = WithoutIdentity<BridgeMessage>;

export function parseBridgeMessage(value: unknown): BridgeMessage {
  if (!bridgeMessage.Check(value)) throw new Error("Invalid bridge message");
  return value;
}

export function parseChildManifest(value: unknown): ChildManifest {
  if (!childManifest.Check(value)) throw new Error("Invalid child manifest");
  return value;
}
