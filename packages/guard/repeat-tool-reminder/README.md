---
description: "Loop-hygiene guard that reminds, then vetoes, identical tool-call loops, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-repeat-tool-reminder

English | [中文](README.zh.md)

## Summary

A model can get stuck calling the same tool with the same arguments — re-running a failing command, re-reading an unchanged file — burning time and tokens without making progress. `dsh-repeat-tool-reminder` notices the pattern and tells the model to stop: at chosen repeat counts it delivers a reminder to analyze the last result and either try a different approach or finish. At `stopAfter` (default: the last threshold, 8 with the shipped defaults) it vetoes that identical call: the post-execute decision is `block`, plugin-sourced stop text is injected, and the agent loop remains free to conclude. Reminders below `stopAfter` stay advisory and do not delay a legitimate repeat. It tracks each agent separately, so one agent's loop never disturbs another's work, and a new user message clears the count. It ships enabled in the `dsh` base bundle with reminders at 3 and 5 repeats and a veto at 8.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when the model should catch itself looping on identical tool calls. There is nothing to learn or wire: the `dsh` base bundle already runs it, and the defaults work for most sessions — tune the thresholds, `stopAfter`, and tool scope below when you want the nudge sooner, later, or on fewer tools.

### When to choose it

Choose it when the model works autonomously for long stretches and a stuck loop is the failure you want to break first with advice, then by vetoing the identical call so the loop can still finish. Avoid it when identical repeats are legitimate and must run past eight consecutive copies — raise `stopAfter` or `exclude` those tools — and when near-identical variants must be caught, because only exact repeats (same tool, same arguments regardless of property order) are detected.

### Setting the thresholds and scope

When you want to change when reminders fire, when the veto starts, or which tools they cover, mount the plugin with configuration:

```yaml
- name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # remind at 3 and 5; 8 is the default stopAfter
    stopAfter: 8                 # veto identical calls at this count and beyond
    include: []                  # track every tool; list patterns to track only some
    exclude: [todo_write]        # never track these tools
    argumentsPreviewChars: 500   # cap on arguments shown in the detailed reminder and stop notice
```

| Field | Default | Meaning |
|---|---|---|
| `thresholds` | `[3, 5, 8]` | Repeat counts that trigger a reminder when they are below `stopAfter` |
| `stopAfter` | last `thresholds` entry (`8`) | Repeat count at which this plugin vetoes the identical call; later identical calls are also vetoed |
| `include` | `[]` | Only these tools are tracked; empty means every tool |
| `exclude` | `[]` | These tools are never tracked; calls to them neither count nor reset |
| `argumentsPreviewChars` | `500` | How many characters of the repeated arguments the detailed reminder and stop notice show |

Invalid configuration fails at startup with a clear error — an empty `thresholds` list, a repeat count or `stopAfter` below 2, a non-integer, or a duplicate threshold — never a silent change of behavior. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) documents every accepted value.

### What you get

With the defaults, a model that repeats the same call with identical arguments receives a short reminder on the third repeat — to analyze the previous result before calling again — a detailed reminder on the fifth, naming the tool and the repeated arguments, and a veto on the eighth: the call's post-execute decision is `block`, the tool result is the stop notice, and the same text is injected as plugin-sourced context. The agent loop is not halted, so the model can still choose a different action or finish. A new user message clears the count, so a fresh instruction is never treated as a loop. Reminder and stop notices appear in the conversation after the repeated call's result, attributed to the plugin.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard detects repeats and delivers reminders, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on four commitments:

- **Remind, then veto.** Below `stopAfter` the guard enriches post-execute decisions with model context and does not block or rewrite a call. At `stopAfter` and beyond it still calls `next()`, then returns `kind: 'block'` with plugin-sourced stop text: this vetoes the repeated tool result so the loop can conclude. It does not skip other listeners, rewrite prompts to evade HITL or command policy, or halt the agent loop.
- **Count in post-execute.** Detection runs on `tools/post-execute`, which also fires for denied calls; counting there lets one listener cover every attempt with no cross-event state.
- **Exact-match canonicalization.** Arguments reach the guard as the loop's `JSON.parse` output (or its raw-string fallback), so JSON's value domain is the whole input domain and a deep key-sort plus `JSON.stringify` is a complete, deterministic identity — no bigint, cycle, or `undefined` handling exists because no input path can produce them.
- **Fail loud at load.** `thresholds`, `stopAfter`, and `argumentsPreviewChars` validate in `apply` and throw, never falling back to defaults. Omitted `stopAfter` resolves to the last `thresholds` entry.

### Detection: the repeat chain

Each agent's chain is keyed by `(tool name, canonical arguments)` — two calls with the same tool and canonically identical arguments (property order ignored) count as consecutive, and a different tracked call resets the count to 1. The chain lives in a `WeakMap<Agent, Chain>`.

- **Untracked calls are transparent to the chain.** A call excluded by `include`/`exclude` neither increments nor resets the counter, so `grep X → todo_write → grep X` still counts as two consecutive `grep X` when `todo_write` is excluded — bookkeeping tools interleaved into a loop do not launder it.
- **Denied calls count.** Detection sits on `tools/post-execute`, which also runs for calls a `tools/pre-execute` listener denied; a model hammering a denied call is exactly the loop worth breaking.
- **Calls without an agent are ignored.** A direct `ctx.tools.execute()` caller has no model to remind and no live agent object to key on.
- **Per-agent keying, reset on user prompts.** One agent's repetition never trips another's reminder; a user prompt (`agent/pre-step`) deletes the submitting agent's chain, and object lifetime bounds the weak entry without a disposal listener.
- **In-memory only.** A session resumed from persistence starts with a fresh chain — the guard is a heuristic nudge, not a logged invariant, so reminders after a resume are the accepted cost.

### Reminder delivery

Reminders ride the post-execute decision's `additionalContexts` (source `{kind: 'plugin', plugin: 'repeat-tool-reminder', form: 'notice', summary: '<tool> × <count>'}`), never a `content` replacement on the reminder path: the `tool/result` event stays the tool's own output for audit. The loop buffers the context and appends it as an injected `user/message` after the step's tool results, which the session renders as a plain synthetic user message — model-visible, source-attributed, and reconstructable from the session log with no new session event. At `stopAfter` the same plugin source is used, but the decision is `block`: `feedback` becomes the error tool result and the stop notice is also prepended onto `additionalContexts`. The guard always delegates via `next()` first, so every downstream listener still runs; stop then replaces the returned decision. It does not bypass HITL, command policy, or other guards.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, chain listeners |
| — | No runtime invariant companion is published; the repeat chain is private to one post-execute listener and exposes no package-owned event or snapshot that an independent companion can observe. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tools waterfall to exhaustive configuration and the guard group map.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/execute` waterfall, `additionalContexts`, and decision shapes this guard consumes.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted config field and its source declaration.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### First-threshold context message

#### What the model sees

At the first configured consecutive-repeat threshold, that agent receives the reminder below. No tool schema or normal-call text is added.

##### First-threshold reminder

```markdown
You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.
```

#### Token effect

Zero tokens before the threshold. The reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Later-threshold context message

#### What the model sees

A later threshold receives the detailed reminder template below. A capped argument preview ends exactly `… (+<omitted> more chars)`.

##### Later-threshold reminder

```markdown
Repeated tool call detected:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.
```

#### Token effect

Each reminder is retained history; `argumentsPreviewChars` bounds its data-dependent argument text, while agents keep independent counters.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Stop-tier block

#### What the model sees

At `stopAfter` and every later identical consecutive call, the agent receives the stop notice below as plugin-sourced context, and the tool result is that same text as an error. No tool schema or normal-call text is added.

##### Stop notice

```markdown
Repeated tool call blocked:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
This identical call was blocked because it made no progress. Do not retry this tool with these exact arguments. Inspect prior results and take a different action, or finish the task if enough evidence has been gathered.
```

#### Token effect

Each stop notice is retained history; `argumentsPreviewChars` bounds its data-dependent argument text.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Exact-match detection only** — canonicalization is a deep key-sort, so near-identical variants (a tweaked path, extra whitespace inside a value) evade the chain; fuzzy matching is rejected pending evidence of need.
- **Compaction does not reset chains** — a chain spanning a compaction checkpoint keeps counting.
- **Post-execute veto cannot undo side effects** — `stopAfter` blocks the tool *result* after the call has already run; a later identical call is also executed then blocked. `exclude` polling tools rather than expecting a pre-execute deny.
- **No subagent chain-sharing** — chains stay isolated per agent; a parent and its subagent repeating the same call never combine.
- **Legitimate idempotent polling still draws nudges and, at `stopAfter`, a veto** — the pressure valves are the `thresholds` / `stopAfter` / `exclude` config.
- **Reminders fire only at exact configured counts below `stopAfter`** — a threshold equal to or above `stopAfter` never delivers a reminder; the stop notice is used instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The [repeat-tool-guard feature note](../../../.agents/notes/archived/feature/2026-07-08-repeat-tool-guard.md) records the original design and alternatives under the former package name; the [naming ledger](../../../.agents/notes/implemented/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md) records the rename to `repeat-tool-reminder` and its reason. The [repeat-tool stop-gate note](../../../.agents/notes/implemented/architecture/2026-09-05-repeat-tool-stop-gate.md) records why the shipped plugin vetoes at `stopAfter` rather than remaining advisory-only.

</details>
