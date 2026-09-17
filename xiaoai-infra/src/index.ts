/**
 * xiaoai 平台 harness 基础设施：从资产目录注入默认 persona。
 * MCP 令牌轮换由 mcp-client `${ENV}` header patch 承担（XIAOAI-MODS #4）。
 * @module xiaoai-infra
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { PERSONA_FILENAME, readPlatformPersona, resolveAssetsDir } from './persona.ts'

export { readPlatformPersona, resolveAssetsDir, DEFAULT_ASSETS_DIR, PERSONA_FILENAME } from './persona.ts'

export const name = 'xiaoai-infra'
export const inject = ['systemPrompt'] as const

const SECTION_NAME = 'xiaoai:platform-persona'

/** 插件配置。 */
export interface Config {
  /** 资产根目录；默认 `$XIAOAI_ASSETS` 或 `/xiaoai-assets`。 */
  assetsDir?: string
  /** persona 相对路径，默认 `persona.md`。 */
  personaFile?: string
  /** 注入 system prompt 的排序（默认 -100，早于 ACP coding persona）。 */
  sectionOrder?: number
}

export const Config: z<Config> = z.object({
  assetsDir: z.string(),
  personaFile: z.string().default(PERSONA_FILENAME),
  sectionOrder: z.number().default(-100),
})

export function apply(ctx: Context, config: Config): void {
  const assetsDir = resolveAssetsDir(config.assetsDir)
  const personaFile = config.personaFile ?? PERSONA_FILENAME
  const order = config.sectionOrder ?? -100

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order,
    text: () => readPlatformPersona(assetsDir, personaFile) ?? '',
  })
}
