# pi-goblins

Lightweight background Pi goblins, with process and PTY ownership provided by [Herdr](https://herdr.dev).

## Requirements

- Linux or macOS
- Herdr client/server `0.7.5` (protocol `17`)
- Herdr Pi integration `v6`
- Pi `>=0.81.1 <0.82.0`

Install the Herdr integration separately:

```bash
herdr integration install pi
```

pi-goblins checks prerequisites on the first summon in each parent session. It never installs or updates Herdr or Pi automatically.

## Installation

```bash
pi install npm:pi-goblins
```

## Tools

| Tool | Behavior |
| --- | --- |
| `summon` | Start one direct task in a new Herdr-owned Pi workspace. Optional `model` and `thinking` overrides. Returns a generated name without waiting for launch or completion. |
| `wait` | Collect terminal results with `mode: "all"` or `"first"`; optionally filter by names. `first` does not cancel other goblins. |
| `dismiss` | Remove and clean a running or terminal uncollected goblin by name, or use `"all"`. |
| `list_goblins` | Refresh and display current state without collecting results. |

Example tool flow:

```text
summon({ task: "Review src/auth.ts for concrete security defects." })
summon({ task: "Run the tests and identify the first actionable failure.", thinking: "low" })
wait({ mode: "first" })
wait({ mode: "all" })
```

Each goblin is a leaf worker. The child receives `--exclude-tools summon,wait,dismiss,list_goblins`, and the main pi-goblins extension disables itself whenever `PI_GOBLINS_CHILD=1`.

## Results

- `completed`: exact text blocks from the child's latest finalized assistant message
- `failed`: partial latest text plus an error, including provider failures
- `truncated`: exact final allowed-turn text when the turn limit is reached

Names stay reserved until `wait` collects or `dismiss` removes the goblin. Concurrent waits cannot collect the same result.

## Configuration

Global configuration lives at `~/.pi/agent/goblins.json`:

```json
{
  "$schema": "https://github.com/Jomik/pi-goblins/blob/main/goblins.schema.json",
  "turnLimit": 30,
  "toolAllowlist": ["read", "edit", "bash", "write", "web_search"],
  "modelPatterns": ["anthropic/*", "openai/gpt-5.6-*"]
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `turnLimit` | `30` | Assistant-turn circuit breaker; minimum 2 |
| `toolAllowlist` | omitted | Omitted keeps Pi's normal tool selection; `[]` passes `--no-tools`; a non-empty list passes `--tools` |
| `modelPatterns` | omitted | Case-sensitive whole canonical `provider/model` globs using `*` and `?`; `[]` denies all models |

The child always receives `--exclude-tools summon,wait,dismiss,list_goblins`. Project trust is captured at summon time and forwarded as `--approve` or `--no-approve`.

Named agents, agent frontmatter, `additionalExtensions`, per-agent grants, and project `.pi/goblins.json` grants are not part of the Herdr design.

## Lifecycle and cleanup

Each goblin uses a private Unix socket and runtime directory plus a workspace labelled:

```text
pi-goblin-<public-name>-<full-launch-id>
```

Collection can finish before asynchronous workspace cleanup, but cooperative Pi shutdown waits for tracked cleanup. pi-goblins never stops the Herdr server and never closes a workspace whose recorded identity does not match.

A hard parent crash or power loss may leave a workspace. Automatic orphan recovery is deferred. To clean one manually:

```bash
herdr workspace list
herdr workspace close <workspace-id>
```

Only close labels beginning `pi-goblin-` after confirming they belong to abandoned work.

See [DESIGN.md](./DESIGN.md) for the complete protocol and lifecycle contract.
