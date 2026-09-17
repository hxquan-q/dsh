import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTokenFile } from '../src/token.ts'

describe('readTokenFile', () => {
  it('returns trimmed token and caches by mtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xiaoai-token-'))
    const file = join(dir, 'token')
    writeFileSync(file, '  bearer-one  \n', 'utf8')
    const cache = { mtimeMs: -1, value: '' }
    expect(readTokenFile(file, cache)).toBe('bearer-one')
    expect(readTokenFile(file, cache)).toBe('bearer-one')

    writeFileSync(file, 'bearer-two', 'utf8')
    cache.mtimeMs = -1
    expect(readTokenFile(file, cache)).toBe('bearer-two')
  })

  it('returns undefined for missing file', () => {
    expect(readTokenFile('/nonexistent/xiaoai-token-file')).toBeUndefined()
  })
})
