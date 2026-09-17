# xiaoai 魔改登记表（升级 replay 唯一依据）

- 上游锚点：tag `dsh-v0.1.6-alpha.1`（入仓时的纯净树，零魔改）
- 上游版本：@deepseek-ai/dsh 0.1.6-alpha.1（tag `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`）
- 上一锚点：tag `dsh-upstream-0.1.2-alpha.4`（`4e84901e6471b79ec0338099867ebb4606d12bb5`）
- 仓库约定：改动优先做**新文件**（新包/新命令）；禁止改 `vendor/`；每处对上游既有文件的编辑必须在本表登记

## 升级 replay 流程

1. `git diff dsh-v0.1.6-alpha.1..HEAD` 取全部魔改（或对照上一锚点 diff 重放）；
2. 对照本表逐项确认意图，replay 到新上游树；
3. 跑 `docs/design/dsh直接二开与插件集成-2026-09-03.md` §6 契约测试矩阵，全绿才换锚点 tag。

## 0.1.6-alpha.1 replay 冲突处置（本锚点新增）

- **patch #4 `mcp-client/transport.ts`**：上游 `489c3ac715` 整体换成官方 SDK（`@modelcontextprotocol/client`）并删去 `as Transport` 转型。`resolveHeaderEnv` 主体照旧，仅贴到新 import 形态上；`createTransport` 每代重读 `process.env`（`buildChildEnv` 只影响 stdio 子进程 env，不影响 streamable-http header 插值）。
- **patch #8 `acp/session.ts` 接线点重做**：上游删除 `assistant/chunk` session 事件（raw chunk 并入 `assistant/message.stream`），新增 `agent/assistant-stream` 派发事件。`WriteDraftStreamer` 主体不变；`session.ts` 从 `onSessionEvent` 截获 `assistant/chunk` 改为新增 `onAssistantStream(frame)` 截获 `agent/assistant-stream` 的 `chunk` 帧（`frame.chunk.type === 'tool-call-delta'`）；`updates.ts` `toolCallProgressUpdate` 不变；`index.ts` 新增 `ctx.on('agent/assistant-stream', ...)` 派发。TASK-882 的文本/思考增量投影仍在上游未做，不受此改动影响。
- **patch #9（本锚点补登记）`repeat-tool-reminder` stop 档**：上一锚点该改动已存在但漏登记（ADR-0033 已记载）。上游 `src/index.ts` 0.1.2→0.1.6 零变化，`stopAfter` veto 逻辑照旧；tests/README 因上游 `ctx.agentLoop.create` 改 async 而适配。

## 登记表

| # | 改动点 | 上游 file:line | 目的 | 可上游 PR |
|---|--------|---------------|------|-----------|
| 1 | 新增 `xiaoai-llm/` 包 | —（新文件） | 令牌文件→凭据 seam 轮换；预注册 xiaoai pi-ai 路由；xiaoai 归因 User-Agent | tool_choice 仍降级（pi-ai SDK） |
| 2 | 新增 `xiaoai-infra/` 包 | —（新文件） | `$XIAOAI_ASSETS/persona.md` 默认 platform persona section | 否（平台私有） |
| 3 | `pnpm-workspace.yaml` + `tsconfig.base.json`/`tsconfig.host.json` 注册新包 | `pnpm-workspace.yaml`；`tsconfig.base.json`；`tsconfig.host.json` | workspace + TS path 别名/引用纳入 xiaoai-llm/xiaoai-infra | 否 |
| 4 | `mcp-client` Streamable HTTP header `${ENV}` | `packages/mcp/mcp-client/src/transport.ts` | MCP Authorization 随环境轮换（每代 `createTransport` 重读） | 是 |
| 5 | `acp-app` bundle 挂载 xiaoai 插件 | `packages/bundle/acp-app/cordis.patch.yml` | ACP profile 默认启用 xiaoai-llm/xiaoai-infra | 否 |
| 6 | `dsh-base` / `sdk-runtime` 闭包依赖 | `packages/bundle/base/package.json`、`python/sdk-runtime/package.json` | 运行镜像 deploy 携带 xiaoai 包 | 否 |
| 7 | `tsdown` workspace 纳入 xiaoai 包 | `tsdown.config.ts` | 否则只产出 `lib/types/*.d.ts`，ACP 启动 `ERR_MODULE_NOT_FOUND`（TASK-656 现场） | 否 |
| 8 | Write 参数流式进 ACP `tool_call_update` in_progress | 新文件 `packages/acp/acp/src/write-draft-stream.ts`；`updates.ts` `toolCallProgressUpdate`；`session.ts` `onAssistantStream` 截获 `agent/assistant-stream` 的 `tool-call-delta` | TASK-828：md Write 边生成边上报 content 后缀；Edit / 非 md 不发 | 否（平台 Canvas 私有） |
| 9 | `repeat-tool-reminder` stop 档（`stopAfter` veto） | `packages/guard/repeat-tool-reminder/src/index.ts` 等 | 死循环防抖升级：低于 `stopAfter` 提醒，达到后 `block` + 注入停止说明（TASK-695） | 否（上游仍是 advisory-only） |
