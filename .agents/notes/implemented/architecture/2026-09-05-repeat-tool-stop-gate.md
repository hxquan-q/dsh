# Agent Note: Repeat-tool stop gate

Status: implemented

English | [中文](2026-09-05-repeat-tool-stop-gate.zh.md)

## Problem

Long coding sessions burn budget on the same tool with the same arguments. The shipped `repeat-tool-reminder` plugin only injects advisory context at configured thresholds; models often ignore the nudge and keep calling. The original [repeat-tool-guard note](../../archived/feature/2026-07-08-repeat-tool-guard.md) deferred escalating to `PostToolDecision` `block`. A stop that rewrites prompts so other guards never see the call, or that auto-approves a background worker, is not acceptable on the enterprise path.

## Decision

`@deepseek-ai/dsh-repeat-tool-reminder` keeps the existing reminder thresholds and adds `stopAfter` (default: the last `thresholds` entry, `8` with the shipped `[3, 5, 8]`). Consecutive identical tracked calls below `stopAfter` still only remind. At `stopAfter` and every later identical call, the post-execute listener still invokes `next()`, then returns `kind: 'block'` with plugin-sourced stop text in both `feedback` (the error tool result) and `additionalContexts` (a `notice` from `repeat-tool-reminder`). The agent loop is not halted, so the model can choose a different action or finish.

A threshold at or above `stopAfter` never fires as a reminder; stop wins. `exclude` remains the escape for legitimate polling. The guard does not skip HITL, command policy, or other waterfall listeners, and it does not rewrite prompts to evade them. The JVM data-query `AgentLoop` dual caps are unchanged.

## Alternatives considered

**Keep the plugin advisory-only and raise reminder frequency.** Rejected: the failure mode is the model ignoring the reminder, not missing a third copy of the same text.

**Halt the agent loop at `stopAfter`.** Rejected: the loop must remain able to conclude; vetoing the repeated tool result is enough.

**Deny on `tools/pre-execute` once the chain is about to hit `stopAfter`.** Rejected for this change: the task contract is a `PostToolDecision` veto. Pre-execute deny would avoid the last side effect but needs a second listener and a pending count; revisit if post-execute side effects on the eighth call prove costly.

**Rewrite the next prompt and then stop, copying QwenPaw `DoomLoopGate`.** Rejected as the product form: changing the prompt to short-circuit other guards, or stopping the loop instead of vetoing the tool, is a different mechanism. This plugin vetoes the repeated tool call only.

**Auto-bypass HITL for background or Mission-style workers so the loop can stop unattended.** Rejected: enterprise sessions must not learn a path that skips approval.

**Default `stopAfter` off.** Rejected for the shipped default: the last threshold already meant "this loop has gone on too long"; making that count a veto matches the existing 3 / 5 / 8 ladder. Operators who need identical retries raise `stopAfter` or `exclude` the tool. If that vetoes legitimate retries whose external state changed, the default can be revisited.

## Consequences

Identical doom loops stop spending budget after `stopAfter` consecutive copies, while 3- and 5-count reminders stay in place. Because the veto is post-execute, the eighth (and later) call still runs before the result is replaced; `exclude` is the valve for poll-style tools. Downstream post-execute `accept` or `block` decisions are replaced at stop, so a later listener cannot keep an identical looping result. Config catalog freshness and the Chinese README pair must move with `Config.stopAfter`.

## Testing

The package spec pins gentle reminder at 3, detailed reminder at 5, no veto at 7, veto at 8 with plugin-sourced stop text and an error tool result, continued veto at 9, custom `stopAfter` below later thresholds, replacement of a downstream accept, and fail-loud `stopAfter` validation. Reminder-fold tests set `stopAfter` above the reminder counts so stop does not shadow them.
