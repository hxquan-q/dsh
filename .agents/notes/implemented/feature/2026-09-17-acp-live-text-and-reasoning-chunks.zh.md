# Agent Note: ACP 现场文本与推理增量投影

Status: implemented

[English](2026-09-17-acp-live-text-and-reasoning-chunks.md) | 中文

## 问题

ACP 桥原先只投影已提交的 `assistant/message` 块。提供方已在 `agent/assistant-stream` 上发出 token 级 `text-delta` / `reasoning-delta`（嵌入 `assistant/message.stream`），但这些帧从未进入 `session/update`。拼接型 ACP 客户端因此在步骤结束才收到一整块 `agent_message_chunk`，无法画出打字机。

xiaoai 的 `AcpJsonRpcClient` 把每条 `agent_message_chunk` 映射为 `TextDelta` 并追加；工作台对 `output.text_delta` 同样追加。subagent 包里的 `AssistantOutputFold` 以已提交消息覆盖流式文本，不会重复——但那条 fold 不在 xiaoai 路径上。若同时发送 live 增量与完整终块，答案会被打印两次。

## 决策

`AcpSession.onAssistantStream` 把非空 `text-delta` 投影为 `agent_message_chunk`、非空 `reasoning-delta` 投影为 `agent_thought_chunk`，走既有 `outputTail` 链，与 TASK-828 的 `tool-call-delta` Write 草稿并列。提交后 `assistantUpdates` 用 `unstreamedSuffix` 扣掉这些 live 前缀：整块已流过则省略；只流过前缀则只发剩余后缀；live 前缀非空且与终块对不上则省略终块，避免拼接型客户端把组装块叠在流上面。图片、用量和通用工具生命周期仍只走提交态。空增量不上线。失败或放弃的尝试没有 ACP 回撤；若后续尝试也在流式，它们的 live 前缀会留在线上。

这只修正 [标准 ACP v1 自动化控制](./2026-08-22-standard-acp-automation-controls.zh.md) 中「原始模型 delta 不上线」对文本和 reasoning 的那一句。

## 考虑过的替代方案

**发 live 增量并保留完整终块。** 实测 xiaoai 后拒绝：`AcpJsonRpcClient.handleNotification` 把每条 `agent_message_chunk` 映射为 `TextDelta`，`LoopEventSseTranslator` 追加到 `streamed`，工作台执行 `acc.text += piece`。拼起来会是答案+答案。

**在 xiaoai adapter 去重。** 本次拒绝：生产者可以省略已匹配的终块后缀，且本任务要求 xiaoai 零改动，除非出现接线缺口。

**前端假打字机。** 更早拒绝（设计树 Q3=A）：流已在 dsh 里，ACP 负责转发出去。

## 后果

拼接型 ACP 客户端在尝试期间看到打字机，终稿仍是一份答案。若客户端把 `agent_message_chunk` 当成「用全文替换」，现在会收到碎片，必须改为拼接；标准 ACP chunk 类型本就是增量。失败或重试尝试的 live 前缀会留在线上。覆盖为 acp 包单测与桥接测试；xiaoai live 探针确认多帧 `output.text_delta`。
