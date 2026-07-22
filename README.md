# pi-goblins

Run background tasks in Pi.

pi-goblins uses [Herdr](https://herdr.dev) for process and PTY ownership. Each goblin runs in a separate tab in the parent Pi workspace.

## Requirements

At the time of writing, these versions were known to work:

- Linux or macOS.
- Herdr client and server `0.7.5` with protocol `17`.
- Herdr Pi integration `v6`.
- Pi `>=0.81.1` and `<0.82.0`.

Install the Herdr integration before you use pi-goblins:

```bash
herdr integration install pi
```

pi-goblins registers its tools only in an identified Herdr pane. It validates summon requests locally. Herdr commands report environment and compatibility failures. It does not install or update Herdr or Pi.

## Install

```bash
pi install npm:pi-goblins
```

## Tools

| Tool           | Behavior                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summon`       | Start one direct task in a new Herdr tab. It returns a generated name without waiting for launch or completion. Use optional `model` and `thinking` overrides. |
| `wait`         | Collect terminal results with `mode: "all"` or `mode: "first"`. Optionally provide `names`. `first` does not cancel other goblins.                             |
| `dismiss`      | Stop and clean one running or terminal uncollected goblin by name. Use `"all"` to dismiss all goblins.                                                         |
| `list_goblins` | Refresh and show current state without collecting results.                                                                                                     |

Example:

```text
summon({ task: "Review src/auth.ts for concrete security defects." })
summon({ task: "Run the tests and identify the first actionable failure.", thinking: "low" })
wait({ mode: "first" })
wait({ mode: "all" })
```

A goblin is a leaf worker. The child cannot start another goblin. The child does not receive `summon`, `wait`, `dismiss`, or `list_goblins`. The extension disables itself in a child session. Outside Herdr, it remains inactive and registers no tools.

## Results

A result has one of these states:

- `completed`: Exact text blocks from the latest finalized assistant message.
- `failed`: Partial latest text and an error, including provider errors.
- `truncated`: Exact final allowed-turn text when the turn limit is reached.
- `dismissed`: The task was stopped before collection.

The first valid child result is authoritative. A later prompt failure cannot replace it. A prompt failure fails only a still-running goblin. A successful prompt without a child result fails after a short grace period.

A name stays reserved until `wait` collects the result or `dismiss` removes it. Concurrent waits cannot collect the same result. An aborted wait collects nothing.

## Configuration

Global configuration lives at `~/.pi/agent/goblins.json`:

```json
{
  "$schema": "https://github.com/Jomik/pi-goblins/blob/main/goblins.schema.json",
  "turnLimit": 50,
  "toolAllowlist": ["read", "edit", "bash", "write", "web_search"],
  "modelPatterns": ["anthropic/*", "openai/gpt-5.6-*"]
}
```

| Setting         | Default | Meaning                                                                                                        |
| --------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `turnLimit`     | `50`    | Assistant-turn circuit breaker. A wrap-up warning is sent with 10 turns remaining. Minimum: `2`.               |
| `toolAllowlist` | Omitted | Keep Pi's normal tool selection. Use `[]` to pass `--no-tools`. Use a non-empty list to pass `--tools`.        |
| `modelPatterns` | Omitted | Match complete, case-sensitive canonical `provider/model` names. Use `*` and `?`. Use `[]` to deny all models. |

Model selection uses `summon.model` first. Otherwise, it uses the active parent model. Model patterns can restrict the selected model.

Project trust is captured at summon time. The child receives `--approve` or `--no-approve` to match that trust mode. The child receives no session persistence. Named agents, agent frontmatter, `additionalExtensions`, per-agent grants, and project `.pi/goblins.json` grants are not supported.

## Lifecycle and cleanup

Each goblin has a private mode-0700 runtime directory. The directory contains a mode-0600 manifest and a private Unix socket. The goblin has one Herdr tab and one bridge connection.

Launch uses this order:

1. Validate the request.
2. Create the runtime directory and manifest.
3. Listen on the bridge socket.
4. Create an unfocused Herdr tab.
5. Start Pi in the tab's root pane.
6. Wait for the first bridge connection.
7. Submit the task to the child.

Tab creation, agent start, and bridge connection share a 60-second deadline. Agent start retries a busy pane for at most five seconds. The task is submitted only after the child connects.

The child sends newline-delimited events for tool previews, turn counts, token counts, and the final result. The bridge validates every event. It enforces limits of 64 KiB for telemetry and 16 MiB for results. It accepts one immutable result. A malformed event or an early disconnect fails the goblin. A disconnect after a result is ignored.

At `turnLimit - 10`, the child receives a wrap-up directive. At the limit, it publishes a `truncated` result before it aborts.

Terminalization starts cleanup. Cleanup aborts active commands, waits for launch teardown, closes the stored tab, closes the bridge, and removes the runtime directory. Cleanup is bounded and memoized. Collection can finish before asynchronous cleanup finishes. Cooperative Pi shutdown waits for tracked cleanup. pi-goblins does not stop Herdr or close the parent workspace.

A hard parent crash or power loss can leave a tab. Automatic orphan recovery is not available. Close an abandoned tab only after you verify its identity:

```bash
herdr tab list --workspace <workspace-id>
herdr tab close <tab-id>
```

See [DESIGN.md](./DESIGN.md) for the complete behavior and protocol.

## Credit and comparison

[pi-imps](https://github.com/Jomik/pi-imps) runs background agents in memory. pi-goblins uses Herdr to herd each goblin in its own tab. This makes each goblin more inspectable. Open its tab to check what it is doing.

Both projects use the same basic summon-and-collect flow. pi-goblins adds Herdr-managed tabs, process ownership, and explicit lifecycle cleanup.

Created by Jomik and PurpleMyst.
