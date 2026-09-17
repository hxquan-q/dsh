# Agent Note: Live ACP text and thinking chunk streaming

Status: implemented

English | [中文](2026-09-17-acp-live-text-streaming.zh.md)

## Problem

The ACP bridge only projected content (into `agent_message_chunk`) at the point a
durable `assistant/message` committed, so an automation client (for example the
xiaoai workbench) saw the full reply arrive at once instead of a typewriter
stream. The process-local `agent/assistant-stream` already exposes per-token
`text-delta` and `reasoning-delta` chunk frames, but the bridge ignored them
except for the Write `tool-call-delta` path (TASK-828). We want the same stream
fidelity on the wire without weakening the committed message contract.

## Decision

`AcpSession.onAssistantStream` — which already owns the transient assistant
stream — now also maps live chunk frames to standard ACP updates:

- `text-delta` → one `agent_message_chunk` (text) update;
- `reasoning-delta` → one `agent_thought_chunk` (text) update.

Each session tracks, per `${turn}:${step}`, the number of text vs reasoning
characters already projected, and the terminal committed
`assistant/message` is decomposed through the shared `assistantUpdates` helper.
`assistantUpdates` strips that already-streamed prefix off each text/reasoning
block before emitting, so an accumulating client that concatenates chunks never
appends the same body twice.

Two upstream tests that pinned "a failed turn publishes nothing" were updated
to the new default: a failed/retried turn now streams its live partial chunks
(`partial` / `partialrecovered`) instead of suppressing them, reflecting the
fact that token-level text is projected as it is produced.

## Alternatives considered

**Keep publishing only at commit.** Preserves the "no partial leak" guarantee
but eliminates the typewriter the task targets.

**Emit live chunks and do not trim the terminal.** Simpler, but any client that
folds updates would receive the full body twice.

**Budget by `turn` only.** Fails across attempts that reuse a `turn` — a retry
re-uses the same budget and over-trims. Keying `${turn}:${step}` and resetting
the budget at each new stream `start` frame avoids that.

## Verification

The ACP bridge suite (`packages/acp/acp/tests`) covers the fold: a failed turn
streams its partial then rejects; a retry adopts the prompt without duplicating
the recovered body; committed reasoning and text are streamed in order; a
bridged session answer aggregates to the exact text; and a dedicated
reasoning+text script asserts multi-frame incremental delivery with no re-send
of the full body.

## Consequences

Automation clients that concatenate `agent_message_chunk` now show live text
and (when the model reasons) live thinking. A turn that streams a final answer
streams its partial body to the wire even when the turn fails or is retried, so
a recipient must fold terminal state and handle failure itself. The DSH durable
session format and the committed `assistant/message` event are unchanged; only
the ACP projection layer was touched.
