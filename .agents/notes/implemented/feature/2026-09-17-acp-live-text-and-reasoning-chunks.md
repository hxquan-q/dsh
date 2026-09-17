# Agent Note: ACP live text and reasoning chunk projection

Status: implemented

English | [中文](2026-09-17-acp-live-text-and-reasoning-chunks.zh.md)

## Problem

The ACP bridge projected only committed `assistant/message` blocks. Providers already emit token-level `text-delta` and `reasoning-delta` on `agent/assistant-stream` (embedded in `assistant/message.stream`), but those frames never reached `session/update`. A concatenative ACP client therefore received one large `agent_message_chunk` at step end and could not paint a typewriter.

xiaoai `AcpJsonRpcClient` maps every `agent_message_chunk` to `TextDelta` and appends; the workbench does the same on `output.text_delta`. `AssistantOutputFold` in the subagent package prefers the committed message over streamed text, so it would not duplicate — that fold is not on the xiaoai path. Sending live deltas and the full committed block would print the answer twice.

## Decision

`AcpSession.onAssistantStream` projects nonempty `text-delta` frames as `agent_message_chunk` and nonempty `reasoning-delta` frames as `agent_thought_chunk` on the existing `outputTail` chain, beside the TASK-828 `tool-call-delta` Write drafts. After commit, `assistantUpdates` subtracts those live prefixes (`unstreamedSuffix`): a fully streamed block is omitted; a partial prefix yields only the remaining suffix; a mismatch with a nonempty live prefix is omitted so concatenative clients do not append the assembled block on top of the stream. Images, usage, and the generic tool lifecycle stay committed-only. Empty deltas stay off the wire. Failed or abandoned attempts have no ACP retract; their live prefix remains if a later attempt also streams.

This amends the "raw model deltas stay off the wire" sentence in [Standard ACP v1 automation controls](./2026-08-22-standard-acp-automation-controls.md) for text and reasoning only.

## Alternatives considered

**Emit live deltas and keep the full committed block.** Rejected after measuring xiaoai: `AcpJsonRpcClient.handleNotification` maps every `agent_message_chunk` to `TextDelta`, `LoopEventSseTranslator` appends to `streamed`, and the workbench does `acc.text += piece`. The joined body would be answer+answer.

**Deduplicate in the xiaoai adapter.** Rejected for this change because the producer can omit the matching committed suffix, and xiaoai stays at zero diff unless a later wiring gap appears.

**Fake typewriter on the frontend.** Rejected earlier (design Q3=A): the stream exists in dsh; ACP forwards it.

## Consequences

ACP clients that append chunks see a typewriter during the attempt and a single assembled answer. Clients that treated `agent_message_chunk` as a replace-with-full-text message now receive fragments and must concatenate; the standard ACP chunk type is incremental. Live prefixes of error or retry attempts stay on the wire. Coverage is the acp package unit and bridge tests; xiaoai live probes confirm multi-frame `output.text_delta`.
