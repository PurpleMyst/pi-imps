# pi-goblins Herdr Design

## Architecture

Each goblin is a cooperating Pi process launched in a visible Herdr tab under the same OS user. Herdr owns the PTY and reports structured agent status; a private Unix socket carries exact child telemetry and results.

The extension registers `summon`, `wait`, `dismiss`, and `list_goblins` only when the parent runs in an identified Herdr pane, and never inside a goblin child. Children cannot invoke the goblin tools.

Each goblin owns:

- an in-memory `GoblinRecord` for terminal state and a `GoblinLifecycle` for runtime resources;
- a labelled tab in the parent workspace;
- a mode-0700 runtime directory containing a mode-0600 manifest and socket;
- one child bridge connection; and
- one memoized cleanup promise.

The parent workspace is borrowed and is never closed. Recovery after a hard parent crash remains manual.

## Public behavior

`summon` atomically rejects admission after shutdown begins, validates the task, model policy, tool selection, and runtime paths, then allocates and registers a name. It returns without waiting for launch or completion. Operational Herdr failures become stored failed results.

`wait` collects immutable snapshots in `all` or `first` mode. Concurrent callers claim synchronously, so a goblin can be collected only once. An aborted wait claims nothing. `dismiss` claims and cleans running or terminal uncollected goblins. Names remain reserved until collection or dismissal.

Results are:

- `completed`: exact text blocks from the latest finalized assistant message;
- `failed`: exact partial text plus the provider or lifecycle error;
- `truncated`: exact final allowed-turn text.

## Launch

Launch follows one direct path:

```text
validate request
→ create private runtime directory and manifest
→ listen on bridge
→ create an unfocused Herdr tab
→ start Pi in the tab's root pane
→ await the first bridge connection
→ submit the task with agent prompt
```

Tab creation, agent start, and bridge connection share a 60-second deadline. `agent start` retries `agent_pane_busy` for at most five seconds. Minimal typed adapters validate successful start and prompt response kinds without restoring identity checks. The task is submitted only after the child connects.

No prerequisite cache or parent workspace/tab/pane prevalidation exists. The runtime lets the concrete Herdr operation report unavailable or incompatible environments. `herdr --version` remains an optional typed adapter, not a launch gate.

## Child bridge

The manifest is schema-derived:

```ts
interface ChildManifest {
  socketPath: string;
  turnLimit: number;
}
```

The child connects during `session_start`. Connection itself establishes readiness. The first accepted connection owns the stream and later connections are rejected.

Newline-delimited, schema-validated child events are:

```ts
type ChildEvent =
  | { type: "tool"; preview: string }
  | { type: "turn"; turns: number; tokens: { input: number; output: number } }
  | { type: "result"; status: "completed"; output: string }
  | { type: "result"; status: "failed"; output: string; error: string }
  | { type: "result"; status: "truncated"; output: string };
```

The bridge enforces fatal UTF-8 decoding, 64-KiB telemetry and 16-MiB result limits, a 512-byte preview limit, nonnegative safe integers, monotonic turn/token counters, and one immutable result. A malformed event or disconnect before a result fails the running record. Disconnect after a result is ignored.

The first valid result is authoritative and terminalizes immediately. A later prompt failure cannot replace it. A prompt failure fails only a still-running record. Prompt success while still running starts a one-second missing-result grace period, after which the record fails if the child did not publish a result.

At turn `limit - 10`, the child steers a wrap-up directive that prioritizes completion, verification, and committing finished changes. At the limit it publishes a `truncated` result before calling Pi's supported abort API.

## Herdr status

Rendered `agent read` output is not used. `list_goblins` and active wait progress refresh structured `idle`, `working`, or `blocked` state through `agent get`, targeting the stored pane ID because generic agent targets are unreliable. Refresh is display-only, single-flight per goblin, and cached for approximately one second.

## Terminalization and cleanup

`GoblinRecord` owns telemetry, snapshots, and a first-write-wins transition from `running` to `completed`, `failed`, `truncated`, or `dismissed`. `GoblinLifecycle` owns launch cancellation, bridge readiness, tab and bridge handles, refresh coordination, and the memoized cleanup promise. Terminalization is the sole cleanup trigger; collection only claims the result and releases its public name. The runtime map owns atomic collection claims, while cleanup tracking is independent from that map.

Cleanup is memoized and bounded:

```text
abort active commands
→ await launch teardown
→ fetch the stored tab ID
→ verify its label
→ close the tab
→ close the bridge
→ remove the runtime directory
```

Command cancellation sends SIGTERM, escalates to SIGKILL after one second, and settles after a second hard-stop grace period. Cleanup does not reconstruct pane layouts, send escape, wait for idle, or use pane-level fallbacks. Cooperative shutdown dismisses all records and waits behind a 65-second barrier. It never stops the Herdr server.

## Model and tool selection

Model resolution uses explicit `summon.model`, then the active parent model. Canonical `provider/model` values are filtered by optional global `modelPatterns`. Tool selection remains tri-state: omitted preserves Pi defaults, empty passes `--no-tools`, and non-empty passes `--tools`. The child receives `--exclude-tools summon,wait,dismiss,list_goblins`, no session persistence, selected thinking, the bridge extension, and the captured trust mode.
