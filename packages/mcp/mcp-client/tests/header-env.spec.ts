/**
 * XIAOAI fork: `${ENV_VAR}` header reference resolution for Streamable HTTP
 * transports. Unresolvable references must drop the header rather than send
 * the literal `${...}` shape to the server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockStreamableCtor } = vi.hoisted(() => {
  class MockStreamableHTTPClientTransport {
    constructor(
      public readonly url: URL,
      public readonly opts: { requestInit: { headers: Record<string, string> } },
    ) {}
  }
  return { mockStreamableCtor: MockStreamableHTTPClientTransport }
})

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: mockStreamableCtor,
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {},
}))

import { createTransport } from '../src/transport.ts'

function headersOf(transport: unknown): Record<string, string> {
  const opts = (transport as { opts: { requestInit: { headers: Record<string, string> } } }).opts
  return opts.requestInit.headers
}

describe('XIAOAI header env resolution', () => {
  const original: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function setEnv(key: string, value: string | undefined): void {
    original[key] ??= process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  it('expands ${VAR} from the environment', () => {
    setEnv('XIAOAI_SESSION_TOKEN', 'xahts.token-value')
    const transport = createTransport({
      transport: 'streamable-http',
      serverName: 'xiaoai',
      url: 'http://gateway.internal/mcp',
      headers: { Authorization: 'Bearer ${XIAOAI_SESSION_TOKEN}' },
      toolCallTimeoutMs: 30000,
      failOnStartupError: false,
    })
    expect(headersOf(transport)).toEqual({ Authorization: 'Bearer xahts.token-value' })
  })

  it('keeps static values untouched', () => {
    const transport = createTransport({
      transport: 'streamable-http',
      serverName: 'xiaoai',
      url: 'http://gateway.internal/mcp',
      headers: { 'X-Platform': 'xiaoai' },
      toolCallTimeoutMs: 30000,
      failOnStartupError: false,
    })
    expect(headersOf(transport)).toEqual({ 'X-Platform': 'xiaoai' })
  })

  it('drops headers whose reference is unresolvable', () => {
    setEnv('XIAOAI_SESSION_TOKEN', undefined)
    const transport = createTransport({
      transport: 'streamable-http',
      serverName: 'xiaoai',
      url: 'http://gateway.internal/mcp',
      headers: {
        Authorization: 'Bearer ${XIAOAI_SESSION_TOKEN}',
        'X-Static': 'kept',
      },
      toolCallTimeoutMs: 30000,
      failOnStartupError: false,
    })
    expect(headersOf(transport)).toEqual({ 'X-Static': 'kept' })
  })

  it('picks up a rotated value on a fresh transport generation', () => {
    setEnv('XIAOAI_SESSION_TOKEN', 'first')
    const generation1 = headersOf(createTransport({
      transport: 'streamable-http',
      serverName: 'xiaoai',
      url: 'http://gateway.internal/mcp',
      headers: { Authorization: 'Bearer ${XIAOAI_SESSION_TOKEN}' },
      toolCallTimeoutMs: 30000,
      failOnStartupError: false,
    }))
    setEnv('XIAOAI_SESSION_TOKEN', 'second')
    const generation2 = headersOf(createTransport({
      transport: 'streamable-http',
      serverName: 'xiaoai',
      url: 'http://gateway.internal/mcp',
      headers: { Authorization: 'Bearer ${XIAOAI_SESSION_TOKEN}' },
      toolCallTimeoutMs: 30000,
      failOnStartupError: false,
    }))
    expect(generation1.Authorization).toBe('Bearer first')
    expect(generation2.Authorization).toBe('Bearer second')
  })
})
