# pi-goblins Herdr Design

## Goal and supported versions

Each goblin is a Pi process and PTY owned by Herdr. The extension preserves the direct-task behavior of `summon`, `wait`, `dismiss`, and `list_goblins`; named-agent selection and all named-agent configuration are removed.

Required versions:

- Herdr client/server `0.7.5`, protocol `17`;
- Herdr Pi integration `v6`;
- Pi `>=0.81.1 <0.82.0`.

The initial release guarantees cooperative cleanup. Recovery after a hard parent crash or power loss is out of scope.

## Public contract

- `summon({ task, model?, thinking? })` returns without waiting for workspace creation, child readiness, prompting, or completion. First-use prerequisites and deterministic validation run before a name is allocated.
- A returned name denotes one task and one terminal result. Later launch failures are stored as `failed` results.
- `wait` supports `all`, `first`, and optional name filters. `first` never cancels other goblins. Concurrent callers cannot collect the same goblin.
- Names remain reserved until collection or dismissal.
- `dismiss` removes running or terminal uncollected goblins. Dismissing a terminal goblin discards its result without changing its status.
- Session replacement, reload, and cooperative shutdown stop and clean every owned worker.
- Results preserve the latest finalized assistant message's text blocks concatenated in order without separators. Provider failures preserve partial text and return `failed`; turn-limit results return `truncated`.
- Child Pi processes cannot invoke `summon`, `wait`, `dismiss`, or `list_goblins`.

## Goblin resources and identities

Each goblin has:

- a public in-memory record and generated public name;
- a random owner ID, launch ID, nonce, and lowercase Herdr agent name;
- a uniquely labelled `pi-goblin-<public-name>-<launch-id>` workspace;
- a private mode-0700 runtime directory, mode-0600 manifest, and Unix socket;
- the child bridge extension; and
- an idempotent memoized cleanup promise.

Public and Herdr identities are separate. Workspace and agent responses are accepted only when their recorded workspace, pane, label, and internal agent identity match the goblin.

Herdr starts the workspace with `PI_GOBLINS_CHILD=1` and `PI_GOBLINS_MANIFEST=<absolute path>`. When `PI_GOBLINS_CHILD=1`, the main extension returns before registering any tools, hooks, prompt text, or UI. Pi resource discovery otherwise remains normal; the tool allowlist is not an extension sandbox.

## Prerequisites and deterministic validation

The first summon in a parent session performs one shared check:

```text
herdr --version
herdr status server --json
herdr integration status
pi --version
```

It requires the supported client/server versions, protocol, running compatible server, structurally parsed `pi: current (v6)` integration entry (a trailing path is allowed), and supported Pi version. It never installs or updates software. Integration errors direct the user to:

```text
herdr integration install pi
```

Successful preflight is cached. A later Herdr version, protocol, integration, socket, or server-availability error invalidates it.

Before allocating a public name, the extension validates:

- no NUL in the task and at most 64 KiB UTF-8;
- absolute runtime paths and a portable Unix-socket path bound;
- model resolution and policy;
- tool and settings resolution.

## Model, tools, and trust

Model source order is explicit `summon.model`, then the current parent model. Available candidates come from `ctx.modelRegistry.getAvailable()` and canonicalize to `provider/id`.

Requested values match exact canonical ID, then exact candidate ID, then exact candidate name. At every tier, a raw match denied by policy fails immediately rather than falling through. Allowed matches are deduplicated by canonical ID; multiple canonical matches are ambiguous.

Optional global `modelPatterns` in `~/.pi/agent/goblins.json` is a case-sensitive, whole-string canonical model allowlist. Only `*` and `?` are wildcards. Omission permits all models; `[]` permits none. Project configuration cannot broaden it.

The child always receives canonical `provider/model`. Tool selection is tri-state after removing the four goblin tools:

| Resolved tools | Pi arguments |
| --- | --- |
| `undefined` | no selection argument |
| `[]` | `--no-tools` |
| non-empty | `--tools <comma-separated>` |

Every child also receives `--exclude-tools summon,wait,dismiss,list_goblins`, `--no-session`, the selected thinking level, the bridge extension, and `--approve` or `--no-approve` captured from `ctx.isProjectTrusted()` at summon time.

## Launch and prompting

The parent creates the socket listener before the workspace. It creates one Herdr workspace rooted at the parent's cwd, then invokes `herdr agent start` with argument arrays, `--kind pi`, the root pane, and child Pi arguments.

Workspace creation, interactive agent start, and authenticated bridge readiness share one absolute 60-second deadline. `agent start` retries only `agent_pane_busy`, every 250 ms, for at most five seconds and never beyond the shared deadline. Herdr's start timeout must remain greater than 3000 ms; launch fails rather than extending the deadline.

The task is not a Pi startup argument. After both Herdr interactive readiness and bridge `ready`, the parent submits:

```text
herdr agent prompt NAME TASK --wait --until idle --until done
```

Its successful identity-matched response is the only Herdr completion signal. `blocked` is display state, not completion, and there is no task wall-clock timeout.

Herdr state is refreshed only for `list_goblins`, active wait progress, and brief dismissal cleanup. Per-goblin refreshes are single-flight and cached for about one second. They are display/diagnostic data and never settle a result.

## Child bridge protocol

The bridge connects during `session_start` and closes idempotently in `session_shutdown`. Newline-delimited JSON is authenticated by protocol version, owner ID, launch ID, and random nonce. The first message is `ready` and includes the exact child Pi version, which must satisfy the supported range. Exactly one connection is accepted.

Messages are:

- `ready`: protocol and identity;
- `tool`: sanitized short activity preview;
- `turn`: monotonic cumulative turns and input/output usage;
- `result`: complete immutable terminal result;
- `error`: fatal bridge failure that cannot produce a result.

Telemetry lines are limited to 64 KiB and `result` to 16 MiB. UTF-8, identity, counters, size, and status invariants are validated. The first valid result is immutable; duplicate results are protocol diagnostics and cannot replace it.

Statuses:

- `completed`: exact latest finalized assistant text;
- `failed`: exact partial text and provider error;
- `truncated`: exact final allowed-turn text.

At turn `limit - 1`, the bridge steers the final-turn directive. At turn `limit`, it publishes and drains the truncated result before calling Pi's supported `ctx.abort()` API. A valid truncated result terminalizes immediately; Herdr settlement is cleanup.

## Terminalization, collection, and dismissal

One first-write-wins terminal compare-and-set governs each goblin.

`completed` and provider `failed` require both a validated bridge result and successful identity-matched prompt response. The counterpart has three seconds to arrive after the first signal; otherwise the goblin receives a stable coordination failure. `truncated` requires only its validated bridge result. `dismissed` can win only while running. Later protocol errors are diagnostics.

Every wait mode and dismissal uses one synchronous claim operation. Claim verifies map identity, atomically removes the record, releases the name, and returns a frozen snapshot. An aborted wait claims nothing. A `wait(first)` loser re-evaluates eligible goblins and returns empty if none remain.

Running dismissal publishes local `dismissed`, resolves local completion, claims/removes the goblin, then starts asynchronous interruption. Terminal dismissal preserves and discards the existing result and returns the name.

## Cleanup and shutdown

Cleanup is memoized and idempotent:

1. abort active Herdr CLI commands;
2. send `esc` only to an identity-matched live agent;
3. briefly wait for idle or disappearance;
4. close only the identity-matched owned workspace;
5. close the socket;
6. remove the runtime directory.

Cleanup promises are tracked independently of the public map. Cooperative shutdown uses one shared promise and one absolute 65-second barrier for quit, reload, new/resume, fork/clone, and other session replacement flows. The extension never stops the Herdr server.

A hard parent crash can leave workspaces. Identify labels beginning `pi-goblin-` with `herdr workspace list`, inspect them, and close the relevant ID with `herdr workspace close <id>`. Automatic orphan reconciliation is deliberately deferred.

## Verification

Unit tests use fake command runners and temporary Unix sockets, never Herdr. They cover prerequisite parsing/caching, model policy, tool/trust arguments, validation, launch coordination, bridge authentication and limits, exact results, collection races, cancellation, dismissal, refresh isolation, and cleanup memoization. An optional live suite may cover representative no-tool/tool, visibility, race, dismissal, denial, provider-failure, and cooperative-cleanup cases.
