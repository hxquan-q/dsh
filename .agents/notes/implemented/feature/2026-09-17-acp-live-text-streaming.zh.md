# Agent Note: ACP 文本与思考实时流式增量

Status: implemented

[English](2026-09-17-acp-live-text-streaming.md) | 中文

## 问题

ACP 桥只在 durable `assistant/message` 提交时整体投影正文（成 `agent_message_chunk`），
因此自动化客户端（如 xiaoai 工作台）会在回合结束时一次性看到整段回复，而不是逐字打字机效果。
进程内 `agent/assistant-stream` 已经按 token 暴露 `text-delta` / `reasoning-delta` chunk 帧，
但桥层除了 Write 的 `tool-call-delta`（TASK-828）外一直忽略它们。目标：在不削弱已提交消息契约
的前提下，把这些流式保真带到线上。

## 决策

`AcpSession.onAssistantStream`（本就持有瞬态 assistant stream）现在把实时 chunk 帧映射为标准的
ACP update：

- `text-delta` → 一次 `agent_message_chunk`（text）update；
- `reasoning-delta` → 一次 `agent_thought_chunk`（text）update。

每个会话按 `${turn}:${step}` 记录已投影的 text / reasoning 字符预算，终块 `assistant/message`
经共享的 `assistantUpdates` helper 分解；`assistantUpdates` 在发出每个 text/reasoning 块前
先扣除已流的字符前缀，因此按块拼接的客户端不会把同一段正文累加两次。

两条原先锁定「失败回合不投影任何内容」的上游测试已按新语义更新：失败/重试回合现在会把
实时 partial 流式下发（`partial` / `partialrecovered`）而不是吞掉——token 级正文本来就在产生时投影。

## 备选方案

**只在提交时投影。** 保留「不漏 partial」，但消灭了任务要的打字机效果。

**只发增量、不裁剪终块。** 更简单，但任何做折叠的客户端都会把全文接到两遍。

**仅按 `turn` 记预算。** 跨尝试复用同一 `turn` 时会累计并过度裁剪。改用 `${turn}:${step}`，
并在每次新 stream `start` 帧把预算清零。

## 验证

ACP 桥测套件（`packages/acp/acp/tests`）覆盖折叠语义：失败回合流式出 partial 再拒绝；重试回合
无重复采纳；已提交思考与正文按序增量到达；会话答案折叠后等于原文；以及一条专用 reasoning+text
脚本断言多帧小粒度下发且不重发全文。

## 影响

按块拼接的自动化客户端现在能看到实时正文与（当模型产 reasoning 时）实时思考。一个流式产出最终
答案的回合即便最终失败/重试，都会先把 partial 发到线上——接收方需自行折叠终态并按失败语义收口。
dsh durable 会话格式与已提交 `assistant/message` 事件均未变，只触及 ACP 投影层。
