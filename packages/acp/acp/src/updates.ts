/** Standard ACP updates derived from live assistant-stream frames and committed events. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import { assistantBlockToAcp } from './content.ts'
import type { WriteDraftIncrement } from './write-draft-stream.ts'

/** Text already sent as live ACP chunks for the in-flight assistant attempt. */
export interface StreamedAssistantPrefix {
  text: string
  reasoning: string
}

/**
 * Project one live stream chunk. Empty and non-text/reasoning chunks are omitted.
 * @param chunk - raw assistant-stream chunk from `agent/assistant-stream`.
 * @returns a standard thought or message chunk, or undefined.
 */
export function assistantChunkUpdate(chunk: StreamChunk): SessionUpdate | undefined {
  if (chunk.type === 'text-delta' && chunk.text.length > 0) {
    return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk.text } }
  }
  if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) {
    return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk.text } }
  }
  return undefined
}

/**
 * Subtract live ACP chunks from a committed block so concatenative clients
 * (xiaoai `AcpJsonRpcClient` appends every `agent_message_chunk`) do not
 * paint the same answer twice.
 * @param committed - assembled block text on `assistant/message`.
 * @param streamed - live prefix not yet consumed by an earlier block.
 * @returns remaining wire text and unused streamed suffix.
 */
export function unstreamedSuffix(committed: string, streamed: string): { text: string; rest: string } {
  if (streamed.startsWith(committed) && committed.length > 0) {
    return { text: '', rest: streamed.slice(committed.length) }
  }
  if (committed.startsWith(streamed)) {
    return { text: committed.slice(streamed.length), rest: '' }
  }
  return { text: streamed.length > 0 ? '' : committed, rest: '' }
}

/**
 * Convert one committed assistant message and its context usage in block order.
 * Live text/reasoning already projected from `assistantChunkUpdate` is omitted
 * or reduced to the unstreamed suffix; images and usage stay committed-only.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @param streamed - live prefixes projected before this commit. Empty default
 *   preserves the committed-only path used when no stream frames arrived.
 * @returns ordered standard thought, message, and optional usage updates.
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
  streamed: StreamedAssistantPrefix = { text: '', reasoning: '' },
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  let remainingText = streamed.text
  let remainingReasoning = streamed.reasoning
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      const leftover = unstreamedSuffix(block.text, remainingReasoning)
      remainingReasoning = leftover.rest
      if (leftover.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: leftover.text },
        })
      }
      continue
    }
    if (block.type === 'text') {
      const leftover = unstreamedSuffix(block.text, remainingText)
      remainingText = leftover.rest
      if (leftover.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_message_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: leftover.text },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content,
      })
    }
  }
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/**
 * Start one generic ACP tool lifecycle from the durable call fact.
 * @param event - committed DSH tool-call event.
 * @returns the standard generic tool-call update.
 */
export function toolCallUpdate(event: SessionEvent<'tool/call'>): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.callId,
    title: event.data.name,
    kind: 'other',
    status: 'in_progress',
    rawInput: parseToolArguments(event.data.arguments),
  }
}

/**
 * Finish one generic ACP tool lifecycle from its committed model-facing result.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @returns the standard completed or failed tool-call update.
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
): Promise<SessionUpdate> {
  const result = event.data.message.content[0]
  const content: ToolCallContent[] = []
  for (const block of result.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: result.toolCallId,
    status: result.isError === true ? 'failed' : 'completed',
    content,
  }
}

/**
 * In-progress content increment for a markdown Write (TASK-828).
 * `content` is a suffix; hosts concatenate by `rawInput.seq`.
 */
export function toolCallProgressUpdate(
  toolCallId: string,
  increment: WriteDraftIncrement,
): SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'in_progress',
    rawInput: { file_path: increment.path, seq: increment.seq },
    content: [{ type: 'content', content: { type: 'text', text: increment.delta } }],
  }
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): SessionUpdate | undefined {
  if (event.data.usage === undefined) return undefined
  const size = session.requestContext()?.contextWindow
  const meter = ctx.get('tokenMeter')
  if (size === undefined || meter === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    used: meter.measure(session).totalTokens,
    size,
  }
}

/** Preserve malformed model output as opaque input instead of dropping the call update. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    return value
  }
}
