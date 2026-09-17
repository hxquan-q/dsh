/** Standard ACP updates derived from committed DSH session events. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import { assistantBlockToAcp } from './content.ts'
import type { WriteDraftIncrement } from './write-draft-stream.ts'

/**
 * Convert one committed assistant message and its context usage in block order.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @param streamed - text/reasoning character counts already projected live from
 *   `agent/assistant-stream` deltas (TASK-882). Their prefix is trimmed off the
 *   committed blocks so an accumulating ACP client does not append them again.
 * @returns ordered standard thought, message, and optional usage updates.
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
  streamed: { text: number; reasoning: number } = { text: 0, reasoning: 0 },
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  let textTail = streamed.text
  let reasoningTail = streamed.reasoning
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      const tail = slicePast(block.text, reasoningTail)
      reasoningTail = countLeft(reasoningTail, block.text.length)
      if (tail.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: tail },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content === undefined) continue
    if (content.type === 'text') {
      const projected = slicePast(content.text, textTail)
      textTail = countLeft(textTail, content.text.length)
      if (projected.length === 0) continue
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content: { type: 'text', text: projected },
      })
      continue
    }
    updates.push({
      sessionUpdate: 'agent_message_chunk',
      messageId: event.data.message.id,
      content,
    })
  }
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/** Return `text` minus its first `prefix` characters, clamped to length 0. */
function slicePast(text: string, prefix: number): string {
  return prefix <= 0 ? text : text.slice(Math.min(prefix, text.length))
}

/** The part of a `prefix` budget not yet consumed by a `length` block. */
function countLeft(prefix: number, length: number): number {
  return Math.max(0, prefix - length)
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
