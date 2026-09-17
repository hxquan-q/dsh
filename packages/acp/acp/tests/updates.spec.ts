import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assistantChunkUpdate,
  assistantUpdates,
  toolCallProgressUpdate,
  toolCallUpdate,
  toolResultUpdate,
  unstreamedSuffix,
} from '../src/updates.ts'

/** Minimal committed assistant event for pure update projection tests. */
function assistantEvent(
  content: SessionEvent<'assistant/message'>['data']['message']['content'],
  usage?: SessionEvent<'assistant/message'>['data']['usage'],
): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    seq: SessionSeq(0),
    time: 0,
    data: {
      stream: [],
      turn: 1,
      step: 1,
      message: {
        id: MessageId('message-1'),
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content,
      },
      ...usage === undefined ? {} : { usage },
    },
  }
}

describe('standard ACP update projection', () => {
  it('omits empty reasoning, unsupported assistant blocks, and absent usage', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const session = { requestContext: () => undefined } as unknown as Session
    const event = assistantEvent([
      { type: 'reasoning', text: '' },
      { type: 'tool-call', id: ToolCallId('call-hidden'), name: 'hidden', arguments: '{}' },
    ])

    await expect(assistantUpdates(ctx, session, event)).resolves.toEqual([])
  })

  it('requires both measured usage and context capacity', async () => {
    const meter = { measure: vi.fn(() => ({ totalTokens: 7 })) }
    const withMeter = { get: (name: string) => name === 'tokenMeter' ? meter : undefined } as unknown as Context
    const withoutMeter = { get: () => undefined } as unknown as Context
    const withCapacity = { requestContext: () => ({ contextWindow: 100 }) } as unknown as Session
    const withoutCapacity = { requestContext: () => undefined } as unknown as Session
    const event = assistantEvent([{ type: 'text', text: 'done' }], { inputTokens: 1, outputTokens: 1 })

    expect((await assistantUpdates(withMeter, withoutCapacity, event)).map(update => update.sessionUpdate))
      .toEqual(['agent_message_chunk'])
    expect((await assistantUpdates(withoutMeter, withCapacity, event)).map(update => update.sessionUpdate))
      .toEqual(['agent_message_chunk'])
    expect(meter.measure).not.toHaveBeenCalled()
  })

  it('preserves malformed tool input and projects a failed result without hidden content', async () => {
    const call = toolCallUpdate({
      type: 'tool/call',
      seq: SessionSeq(0),
      time: 0,
      data: { turn: 1, step: 1, callId: ToolCallId('call-bad'), name: 'broken', arguments: '{' },
    })
    const result = await toolResultUpdate({ get: () => undefined } as unknown as Context, {
      type: 'tool/result',
      surfaceOp: 'append',
      seq: SessionSeq(0),
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('tool-message'),
          role: 'user',
          source: { kind: 'tool', callId: ToolCallId('call-bad') },
          content: [{
            type: 'tool-result',
            toolCallId: ToolCallId('call-bad'),
            isError: true,
            content: [{ type: 'reasoning', text: 'hidden' }],
          }],
        },
      },
    })

    expect(call).toMatchObject({ rawInput: '{' })
    expect(result).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-bad',
      status: 'failed',
      content: [],
    })
  })

  it('projects an in_progress write increment with seq and suffix text', () => {
    expect(toolCallProgressUpdate('call-w', { path: 'report.md', seq: 2, delta: '## 节' })).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-w',
      status: 'in_progress',
      rawInput: { file_path: 'report.md', seq: 2 },
      content: [{ type: 'content', content: { type: 'text', text: '## 节' } }],
    })
  })

  it('subtracts live prefixes so concatenative clients do not reprint committed text', () => {
    expect(unstreamedSuffix('Hello', 'Hello')).toEqual({ text: '', rest: '' })
    expect(unstreamedSuffix('Hello', 'Hel')).toEqual({ text: 'lo', rest: '' })
    expect(unstreamedSuffix('Hello', 'Hello extra')).toEqual({ text: '', rest: ' extra' })
    expect(unstreamedSuffix('Hello', 'xyz')).toEqual({ text: '', rest: '' })
    expect(unstreamedSuffix('Hello', '')).toEqual({ text: 'Hello', rest: '' })
  })

  it('projects nonempty text and reasoning deltas and ignores other chunks', () => {
    expect(assistantChunkUpdate({ type: 'text-delta', index: 0, text: 'ab' })).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'ab' },
    })
    expect(assistantChunkUpdate({ type: 'reasoning-delta', index: 0, text: 'why' })).toEqual({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'why' },
    })
    expect(assistantChunkUpdate({ type: 'text-delta', index: 0, text: '' })).toBeUndefined()
    expect(assistantChunkUpdate({
      type: 'tool-call-delta',
      index: 0,
      id: ToolCallId('c'),
      argumentsDelta: '{',
    })).toBeUndefined()
  })

  it('omits committed text and reasoning that live deltas already projected', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const session = { requestContext: () => undefined } as unknown as Session
    const event = assistantEvent([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'Hello' },
    ])

    await expect(assistantUpdates(ctx, session, event, { text: 'Hello', reasoning: 'thinking' }))
      .resolves.toEqual([])
    await expect(assistantUpdates(ctx, session, event, { text: 'Hel', reasoning: 'think' }))
      .resolves.toEqual([
        {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'message-1',
          content: { type: 'text', text: 'ing' },
        },
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-1',
          content: { type: 'text', text: 'lo' },
        },
      ])
  })
})
