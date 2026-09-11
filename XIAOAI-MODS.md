# xiaoai 魔改登记表（升级 replay 唯一依据）

- 上游锚点：tag `dsh-upstream-0.1.2-alpha.4`（入仓时的纯净树，零魔改）
- 上游版本：@deepseek-ai/dsh 0.1.2-alpha.4（zip 哈希 4e84901e6471b79ec0338099867ebb4606d12bb5）
- 仓库约定：改动优先做**新文件**（新包/新命令）；禁止改 `vendor/`；每处对上游既有文件的编辑必须在本表登记

## 升级 replay 流程

1. `git diff dsh-upstream-0.1.2-alpha.4..HEAD -- harness/dsh-src` 取全部魔改；
2. 对照本表逐项确认意图，replay 到新上游树；
3. 跑 `docs/design/dsh直接二开与插件集成-2026-09-03.md` §6 契约测试矩阵，全绿才换锚点 tag。

## 登记表

| # | 改动点 | 上游 file:line | 目的 | 可上游 PR |
|---|--------|---------------|------|-----------|
| 1 | 新增 `xiaoai-llm/` 包 | —（新文件） | 令牌文件→凭据 seam 轮换；预注册 xiaoai pi-ai 路由；xiaoai 归因 User-Agent | tool_choice 仍降级（pi-ai SDK） |
| 2 | 新增 `xiaoai-infra/` 包 | —（新文件） | `$XIAOAI_ASSETS/persona.md` 默认 platform persona section | 否（平台私有） |
| 3 | `pnpm-workspace.yaml` 注册新包 | `pnpm-workspace.yaml:13-16` | workspace 纳入 xiaoai-llm/xiaoai-infra | 否 |
| 4 | `mcp-client` Streamable HTTP header `${ENV}` | `packages/mcp/mcp-client/src/transport.ts:29-47` | MCP Authorization 随环境轮换（每代 `createTransport` 重读） | 是 |
| 5 | `acp-app` bundle 挂载 xiaoai 插件 | `packages/bundle/acp-app/cordis.patch.yml:8-13` | ACP profile 默认启用 xiaoai-llm/xiaoai-infra | 否 |
| 6 | `dsh-base` / `sdk-runtime` 闭包依赖 | `packages/bundle/base/package.json`、`python/sdk-runtime/package.json` | 运行镜像 deploy 携带 xiaoai 包 | 否 |
| 7 | `tsdown` workspace 纳入 xiaoai 包 | `tsdown.config.ts:19` | 否则只产出 `lib/types/*.d.ts`，ACP 启动 `ERR_MODULE_NOT_FOUND`（TASK-656 现场） | 否 |
| 8 | Write 参数流式进 ACP `tool_call_update` in_progress | 新文件 `packages/acp/acp/src/write-draft-stream.ts`；`updates.ts` `toolCallProgressUpdate`；`session.ts` `onSessionEvent` 截获 `assistant/chunk`/`tool-call-delta` | TASK-828：md Write 边生成边上报 content 后缀；Edit / 非 md 不发 | 否（平台 Canvas 私有） |
