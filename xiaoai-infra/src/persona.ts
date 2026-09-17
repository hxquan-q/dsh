/**
 * 从 xiaoai 资产目录读取平台 persona 默认文案。
 * @module xiaoai-infra/persona
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 默认资产根目录（容器内只读挂载）。 */
export const DEFAULT_ASSETS_DIR = '/xiaoai-assets'

/** persona 文件名。 */
export const PERSONA_FILENAME = 'persona.md'

/**
 * 读取平台 persona；缺失或空文件返回 `undefined`。
 * @param assetsDir - 资产根目录，默认 `$XIAOAI_ASSETS` 或 `/xiaoai-assets`
 * @param personaFile - 相对文件名，默认 `persona.md`
 */
export function readPlatformPersona(
  assetsDir: string,
  personaFile: string = PERSONA_FILENAME,
): string | undefined {
  const path = join(assetsDir, personaFile)
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8').trim()
  return text.length > 0 ? text : undefined
}

/**
 * 解析资产目录：显式配置 > `$XIAOAI_ASSETS` > 默认路径。
 */
export function resolveAssetsDir(configured?: string): string {
  if (configured !== undefined && configured.trim().length > 0) {
    return configured.trim()
  }
  const fromEnv = process.env.XIAOAI_ASSETS?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return DEFAULT_ASSETS_DIR
}
