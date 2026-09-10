/**
 * xiaoai 平台 LLM 集成：令牌文件轮换同步到凭据 seam、预注册 xiaoai pi-ai 路由、归因头。
 * @module xiaoai-llm
 */

import { watch } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { attributionHeaders, type AppIdentity } from '@deepseek-ai/dsh-llm'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Config as PiAiPluginConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-settings'
import { readTokenFile, type TokenFileCache } from './token.ts'

export { readTokenFile } from './token.ts'
export type { TokenFileCache } from './token.ts'

/** xiaoai harness 归因身份（替换默认 deepseek-harness User-Agent）。 */
export const XIAOAI_APP_IDENTITY: AppIdentity = {
  product: 'xiaoai-harness',
  version: '0.1.0',
  url: 'https://github.com/xquan/xiaoai',
}

export const name = 'xiaoai-llm'
export const inject = ['credentials', 'settings'] as const

const LLM_PI_AI_NS = 'llm-pi-ai'
const PROVIDER_ROUTE = 'xiaoai'
const DEFAULT_TOKEN_FILE = '/xiaoai-assets/token'
const DEFAULT_CREDENTIAL_REF = 'XIAOAI_SESSION_TOKEN'
const DEFAULT_GATEWAY_ENV = 'XIAOAI_GATEWAY_BASE_URL'
const DEFAULT_MODEL_ENV = 'XIAOAI_DEFAULT_MODEL'
const DEFAULT_MODEL_ID = 'default'

/** 插件配置：令牌文件路径与网关默认值。 */
export interface Config {
  /** 只读挂载的会话令牌文件；每次变更同步到凭据 seam。 */
  tokenFile?: string
  /** settings / 凭据里引用的 credential ref 名。 */
  credentialRef?: string
  /** 网关根 URL 的环境变量名（无 settings 物化时的回退）。 */
  gatewayBaseURLEnv?: string
  /** 默认模型 id 的环境变量名。 */
  defaultModelEnv?: string
  /** 是否向 llm-pi-ai 安装内置 xiaoai provider 段（默认 true）。 */
  registerProvider?: boolean
}

export const Config: z<Config> = z.object({
  tokenFile: z.string().default(DEFAULT_TOKEN_FILE),
  credentialRef: z.string().role('credential-ref').default(DEFAULT_CREDENTIAL_REF),
  gatewayBaseURLEnv: z.string().default(DEFAULT_GATEWAY_ENV),
  defaultModelEnv: z.string().default(DEFAULT_MODEL_ENV),
  registerProvider: z.boolean().default(true),
})

async function syncTokenToCredentials(
  ctx: Context,
  ref: CredentialRef,
  tokenFile: string,
  cache: TokenFileCache,
): Promise<void> {
  const token = readTokenFile(tokenFile, cache)
  if (token === undefined) return
  try {
    await ctx.credentials.set(ref, token)
  } catch (error) {
    ctx.logger.warn(`xiaoai-llm: failed to publish token from ${tokenFile} to credentials`)
    ctx.logger.warn(error)
  }
}

function resolveGatewayBaseURL(envName: string): string | undefined {
  const value = process.env[envName]?.trim()
  return value !== undefined && value.length > 0 ? value.replace(/\/$/, '') : undefined
}

function resolveDefaultModel(envName: string): string {
  const value = process.env[envName]?.trim()
  return value !== undefined && value.length > 0 ? value : DEFAULT_MODEL_ID
}

function buildPiAiSection(
  gatewayBaseURL: string | undefined,
  modelId: string,
  credentialRefName: CredentialRef,
): PiAiPluginConfig {
  const baseURL = gatewayBaseURL ?? 'http://127.0.0.1:8080/internal/harness/v1'
  return {
    providers: {
      [PROVIDER_ROUTE]: {
        displayName: 'xiaoai',
        api: 'openai-completions',
        baseURL,
        apiKeyEnv: credentialRefName,
        headers: attributionHeaders(XIAOAI_APP_IDENTITY),
        models: [{
          id: modelId,
          name: modelId,
          contextWindow: 131_072,
          maxTokens: 8192,
          input: ['text'],
        }],
      },
    },
  }
}

export function apply(ctx: Context, config: Config): void {
  const tokenFile = config.tokenFile ?? DEFAULT_TOKEN_FILE
  const ref = credentialRef(config.credentialRef ?? DEFAULT_CREDENTIAL_REF)
  const gatewayEnv = config.gatewayBaseURLEnv ?? DEFAULT_GATEWAY_ENV
  const modelEnv = config.defaultModelEnv ?? DEFAULT_MODEL_ENV
  const cache: TokenFileCache = { mtimeMs: -1, value: '' }

  void syncTokenToCredentials(ctx, ref, tokenFile, cache)

  let watcher: ReturnType<typeof watch> | undefined
  try {
    watcher = watch(tokenFile, () => { void syncTokenToCredentials(ctx, ref, tokenFile, cache) })
  } catch {
    ctx.logger.warn(`xiaoai-llm: token file not watchable yet: ${tokenFile}`)
  }
  ctx.effect(() => () => { watcher?.close() }, 'xiaoai-llm.tokenWatch')

  if (config.registerProvider ?? true) {
    const section = buildPiAiSection(
      resolveGatewayBaseURL(gatewayEnv),
      resolveDefaultModel(modelEnv),
      ref,
    )
    ctx.inject(['settings'], (settingsCtx) => {
      let current: () => PiAiPluginConfig = () => section
      settingsCtx.settings.installSection(ctx, LLM_PI_AI_NS, PiAiConfig, section, {
        setSource: (source) => {
          current = source
        },
        onChange: () => {
          void current()
        },
      })
    })
  }
}
