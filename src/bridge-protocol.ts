import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const NonnegativeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const ResultEventSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("result"), status: Type.Literal("completed"), output: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("result"),
      status: Type.Literal("failed"),
      output: Type.String(),
      error: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("result"), status: Type.Literal("truncated"), output: Type.String() },
    { additionalProperties: false },
  ),
]);

export const ChildEventSchema = Type.Union([
  Type.Object({ type: Type.Literal("tool"), preview: Type.String() }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal("turn"),
      turns: NonnegativeInteger,
      tokens: Type.Object({ input: NonnegativeInteger, output: NonnegativeInteger }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
  ResultEventSchema,
]);

export const ChildManifestSchema = Type.Object(
  {
    socketPath: Type.String(),
    turnLimit: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

const childEvent = Compile(ChildEventSchema);
const childManifest = Compile(ChildManifestSchema);

export type ChildEvent = Static<typeof ChildEventSchema>;
type WithoutType<Event> = Event extends unknown ? Omit<Event, "type"> : never;
export type TerminalResult = WithoutType<Extract<ChildEvent, { type: "result" }>>;
export type ChildManifest = Static<typeof ChildManifestSchema>;

export function parseChildEvent(value: unknown): ChildEvent {
  if (!childEvent.Check(value)) throw new Error("Invalid child event");
  return value;
}

export function parseChildManifest(value: unknown): ChildManifest {
  if (!childManifest.Check(value)) throw new Error("Invalid child manifest");
  return value;
}
