import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createUserMessage, ToolCallId, type StreamChunk  } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

function toolCallResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'inspect first' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'inspect first' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: ToolCallId('call-1'), name: 'echo', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('call-1'), name: 'echo', arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, reasoningTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('ACP automation output boundary', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('emits committed reasoning, generic tool lifecycle, usage, and final text in order', async () => {
    harness = await makeBridgeHarness({ script: [toolCallResponse(), textResponse('done')] })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Return a deterministic result.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'tool result' }]),
    }))
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update') })
    const text = harness.updates.flatMap(update => update.sessionUpdate === 'agent_message_chunk'
      && update.content.type === 'text' ? [update.content.text] : []).join('')
    const thought = harness.updates.flatMap(update => update.sessionUpdate === 'agent_thought_chunk'
      && update.content.type === 'text' ? [update.content.text] : []).join('')
    const kindOrder = harness.updates.map(update => update.sessionUpdate)
    expect(kindOrder.filter(kind => kind === 'tool_call').length).toBe(1)
    expect(kindOrder.filter(kind => kind === 'tool_call_update').length).toBe(1)
    await vi.waitFor(() => {
      expect(kindOrder.indexOf('agent_thought_chunk')).toBeGreaterThan(-1)
      expect(kindOrder.indexOf('tool_call')).toBeGreaterThan(kindOrder.indexOf('agent_thought_chunk'))
      expect(kindOrder.indexOf('tool_call_update')).toBeGreaterThan(kindOrder.indexOf('tool_call'))
      expect(kindOrder.lastIndexOf('agent_message_chunk')).toBeGreaterThan(kindOrder.indexOf('tool_call_update'))
    })
    expect(thought).toBe('inspect first')
    expect(text).toBe('done')
    const toolCall = harness.updates.find(update => update.sessionUpdate === 'tool_call')
    expect(toolCall).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'echo',
      kind: 'other',
      status: 'in_progress',
      rawInput: {},
    })
    const toolUpdate = harness.updates.find(update => update.sessionUpdate === 'tool_call_update')
    expect(toolUpdate).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'tool result' } }],
    })
    const usage = harness.updates.filter(update => update.sessionUpdate === 'usage_update')
    expect(usage.length).toBeGreaterThan(0)
    expect(usage.at(-1)).toMatchObject({ size: 1_024 })
  })

  it('ignores events from agents the bridge does not own', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('foreign')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const { agent } = await harness.ctx.agents.create({
      sessionId: SessionId('foreign'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(harness.updates).toHaveLength(0)
  })

  it('delivers output from a bridge-owned session driven by another in-process producer', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('external')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'plugin', plugin: 'test' } }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update') })

    // 真流式（TASK-882）：增量折叠后等于完整答案。
    const text = harness.updates.flatMap(update => update.sessionUpdate === 'agent_message_chunk'
      && update.content.type === 'text' ? [update.content.text] : []).join('')
    expect(text).toBe('external')
  })

  it('contains output conversion failure outside an ACP prompt', async () => {
    harness = await makeBridgeHarness({ script: [[
      { type: 'block-start', index: 0, blockType: 'image' },
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'image',
          attachment: {
            attachmentId: `sha256:${'a'.repeat(64)}` as never,
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ]] })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'plugin', plugin: 'test' } }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('output conversion failed')) })
    expect(harness.updates).toEqual([])
  })

  // `session/update` is a JSON-RPC notification, so a client-side handler
  // failure never reaches the bridge; this pins that the prompt still settles
  // normally with such a client. The bridge's own write-failure guard is
  // transport-level and documented untestable at `notify`.
  it('settles the prompt normally when the client rejects update notifications', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    harness.onSessionUpdateError = () => {}
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
  })
})
