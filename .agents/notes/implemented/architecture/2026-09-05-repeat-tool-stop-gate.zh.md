# Agent Note: 重复工具调用的停止档

Status: implemented

[English](2026-09-05-repeat-tool-stop-gate.md) | 中文

## 问题

长编码会话会在同一工具、同一参数上烧预算。已交付的 `repeat-tool-reminder` 插件只在配置的阈值注入建议性上下文；模型常常忽略提醒并继续调用。原 [repeat-tool-guard 记录](../../archived/feature/2026-07-08-repeat-tool-guard.md) 把升级为 `PostToolDecision` `block` 留作延期。用改写 prompt 让其他守卫看不到这次调用、或让后台 worker 自动批准，不能作为企业路径。

## 决定

`@deepseek-ai/dsh-repeat-tool-reminder` 保留现有提醒阈值，并增加 `stopAfter`（默认：最后一个 `thresholds` 项，随附 `[3, 5, 8]` 时为 `8`）。低于 `stopAfter` 的连续相同受跟踪调用仍只提醒。达到 `stopAfter` 以及之后每一次相同调用时，post-execute 监听器仍调用 `next()`，然后返回 `kind: 'block'`，并在 `feedback`（错误工具结果）和 `additionalContexts`（来自 `repeat-tool-reminder` 的 `notice`）中放入带插件来源的停止文本。agent loop（智能体循环）不会被停止，因此模型仍可选择其他动作或结束任务。

等于或高于 `stopAfter` 的阈值不会再作为提醒触发；停止档优先。`exclude` 仍是合法轮询的出口。该守卫不跳过 HITL（人在回路）、命令策略或其他 waterfall 监听器，也不改写 prompt 以规避它们。JVM 问数 `AgentLoop` 双上限保持不变。

## 考虑过的替代方案

**保持插件仅建议，并提高提醒频率。** 否决：失败模式是模型忽略提醒，而不是少看一遍同一段文本。

**在 `stopAfter` 停止整个 agent loop。** 否决：循环必须仍能收尾；否决重复的工具结果已经足够。

**一旦链即将达到 `stopAfter`，在 `tools/pre-execute` 拒绝。** 本次变更否决：任务契约是 `PostToolDecision` 否决。pre-execute 拒绝可以避免最后一次副作用，但需要第二个监听器和待决计数；若第八次调用的 post-execute 副作用被证明代价过高，再评估。

**改写下一条 prompt 再停止，照搬 QwenPaw `DoomLoopGate`。** 作为产品形态否决：改 prompt 让其他守卫短路、或停止循环而不是否决工具，是另一种机制。本插件只否决这次重复的工具调用。

**为后台或 Mission 风格 worker 自动绕过 HITL，以便无人值守时停循环。** 否决：企业会话不得学会一条跳过审批的路径。

**默认关闭 `stopAfter`。** 作为随附默认值否决：最后一个阈值本来就表示「这个循环已经太久」；让该次数变成否决，与现有 3 / 5 / 8 阶梯一致。需要相同重试的运营方提高 `stopAfter` 或 `exclude` 该工具。若否决了外部状态已变的合法重试，可以再评估默认值。

## 后果

相同的 doom loop 在连续 `stopAfter` 次之后停止消耗预算，而 3 次与 5 次提醒保持原样。因为否决发生在 post-execute，第八次（及之后）调用仍会先跑再替换结果；轮询类工具用 `exclude` 减压。停止档会替换下游 post-execute 的 `accept` 或 `block`，因此后续监听器不能保住一次循环中的相同结果。`Config.stopAfter` 必须连同配置目录新鲜度与中文 README 配对一起更新。

## 验证

本包 spec 钉死：第 3 次温和提醒、第 5 次详细提醒、第 7 次不否决、第 8 次否决（带插件来源停止说明与错误工具结果）、第 9 次继续否决、自定义低于后续阈值的 `stopAfter`、替换下游 accept，以及 `stopAfter` 快速失败校验。提醒折叠测试把 `stopAfter` 设得高于提醒次数，以免停止档盖住它们。
