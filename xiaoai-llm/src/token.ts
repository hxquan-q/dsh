/**
 * 从只读挂载的令牌文件读取 Bearer，支持 mtime 缓存与轮换检测。
 * @module xiaoai-llm/token
 */

import { readFileSync, statSync } from 'node:fs'

/** 一次读取的缓存条目（按文件 mtime 失效）。 */
export interface TokenFileCache {
  mtimeMs: number
  value: string
}

/**
 * 读取令牌文件内容（trim 后非空才返回）。
 * @param filePath - 绝对路径，通常为 `/xiaoai-assets/token`
 * @param cache - 可选缓存；mtime 未变时直接返回缓存值
 * @returns 令牌字符串，文件缺失或为空时返回 `undefined`
 */
export function readTokenFile(
  filePath: string,
  cache?: TokenFileCache,
): string | undefined {
  let mtimeMs: number
  try {
    mtimeMs = statSync(filePath).mtimeMs
  } catch {
    return undefined
  }
  if (cache !== undefined && cache.mtimeMs === mtimeMs) {
    return cache.value.length > 0 ? cache.value : undefined
  }
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
  const value = raw.trim()
  if (cache !== undefined) {
    cache.mtimeMs = mtimeMs
    cache.value = value
  }
  return value.length > 0 ? value : undefined
}
