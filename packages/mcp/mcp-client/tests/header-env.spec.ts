/**
 * XIAOAI fork: `${ENV_VAR}` header reference resolution for Streamable HTTP
 * transports. Unresolvable references must drop the header rather than send
 * the literal `${...}` shape to the server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { MockStreamableCtor } = vi.hoisted(() => {
  class MockStreamableHTTPClientTransport {
    readonly url: URL
    readonly opts: { requestInit: { headers: Record<string, string> } }
    constructor(url: URL, opts: { requestInit: { headers: Record<string, string> } }) {
      this.url = url
      this.opts = opts
    }
    /** Assertion seam: the headers captured at transport construction. */
    requestHeaders(): Record<string, string> {
      return this.opts.requestInit.headers
    }
  }
  return { MockStreamableCtor: MockStreamableHTTPClientTransport }
})

vi.mock('@modelcontextprotocol/client', () => ({
  StreamableHTTPClientTransport: MockStreamableCtor,
}))
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(),
}))

import { createTransport } from '../src/transport.ts'

function makeTransport(headers: Record<string, string>): { requestHeaders(): Record<string, string> } {
  const transport = createTransport({
    transport: 'streamable-http',
    serverName: 'xiaoai',
    url: 'http://gateway.internal/mcp',
    headers,
    toolCallTimeoutMs: 30000,
    failOnStartupError: false,
  })
  return transport as unknown as { requestHeaders(): Record<string, string> }
}

describe('XIAOAI header env resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('expands ${VAR} from the environment', () => {
    vi.stubEnv('XIAOAI_SESSION_TOKEN', 'xahts.token-value')
    expect(makeTransport({ Authorization: 'Bearer ${XIAOAI_SESSION_TOKEN}' }).requestHeaders())
      .toEqual({ Authorization: 'Bearer xahts.token-value' })
  })

  it('keeps static values untouched', () => {
    expect(makeTransport({ 'X-Platform': 'xiaoai' }).requestHeaders())
      .toEqual({ 'X-Platform': 'xiaoai' })
  })

  it('drops headers whose reference is unresolvable', () => {
    vi.stubEnv('XIAOAI_SESSION_TOKEN', undefined)
    expect(makeTransport({
      Authorization: 'Bearer ${XIAOAI_SESSION_TOKEN}',
      'X-Static': 'kept',
    }).requestHeaders()).toEqual({ 'X-Static': 'kept' })
  })

  it('picks up a rotated value on a fresh transport generation', () => {
    vi.stubEnv('XIAOAI_SESSION_TOKEN', 'first')
    const generation1 = makeTransport({ Authorization: 'Bearer ${XIAOAI_SESSION_TOKEN}' }).requestHeaders()
    vi.stubEnv('XIAOAI_SESSION_TOKEN', 'second')
    const generation2 = makeTransport({ Authorization: 'Bearer ${XIAOAI_SESSION_TOKEN}' }).requestHeaders()
    expect(generation1.Authorization).toBe('Bearer first')
    expect(generation2.Authorization).toBe('Bearer second')
  })
})
