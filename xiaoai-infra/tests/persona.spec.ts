import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPlatformPersona, resolveAssetsDir } from '../src/persona.ts'

describe('readPlatformPersona', () => {
  let dir: string

  afterEach(() => {
    void dir
  })

  it('reads persona.md when present', () => {
    dir = mkdtempSync(join(tmpdir(), 'xiaoai-assets-'))
    writeFileSync(join(dir, 'persona.md'), '# Platform\n你是 xiaoai 助手。\n', 'utf8')
    expect(readPlatformPersona(dir)).toBe('# Platform\n你是 xiaoai 助手。')
  })

  it('returns undefined when file missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'xiaoai-assets-empty-'))
    expect(readPlatformPersona(dir)).toBeUndefined()
  })
})

describe('resolveAssetsDir', () => {
  const original = process.env.XIAOAI_ASSETS

  afterEach(() => {
    if (original === undefined) delete process.env.XIAOAI_ASSETS
    else process.env.XIAOAI_ASSETS = original
  })

  it('prefers explicit config over environment', () => {
    process.env.XIAOAI_ASSETS = '/from-env'
    expect(resolveAssetsDir('/configured')).toBe('/configured')
  })

  it('falls back to default mount path', () => {
    delete process.env.XIAOAI_ASSETS
    expect(resolveAssetsDir()).toBe('/xiaoai-assets')
  })
})
