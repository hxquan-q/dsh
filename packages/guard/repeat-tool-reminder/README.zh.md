---
description: "循环卫生 guard：先提醒、再否决相同工具调用循环，供选择、配置或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-repeat-tool-reminder

[English](README.md) | 中文

## 概述

模型可能会卡在以相同参数调用同一工具上——反复运行失败的命令、反复读取未变化的文件——白白消耗时间和 token 却没有进展。`dsh-repeat-tool-reminder` 会发现这种模式并让模型停下来：在选定的重复次数上，它送出一条提醒，要求模型分析上一次结果并改用其他方法或结束任务。达到 `stopAfter`（默认：最后一个阈值，随附默认值为 8）时，它否决该次相同调用：post-execute 决策为 `block`，注入带插件来源的停止说明，agent loop（智能体循环）仍可收尾。低于 `stopAfter` 的提醒仍只是建议，不会延迟合理的重复。它分别跟踪每个 agent（智能体），一个 agent 的循环绝不会干扰另一个 agent 的工作，新的用户消息会清零计数。它随 `dsh` base 组合默认启用，在 3、5 次重复时提醒，在 8 次时否决。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当模型应当自行发现自己在相同工具调用上循环时，挂载此插件。无需学习或接线：`dsh` base 组合已经运行它，默认值适用于大多数会话——想更早、更晚或在更少的工具上收到提醒或否决时，调优下面的阈值、`stopAfter` 与工具范围即可。

### 何时选择

当模型长时间自主工作、且卡住的循环是你想先用建议、再通过否决相同调用以便循环仍能结束来打破的失败模式时，选择它。当相同的重复是合理且必须连续运行超过八次——请提高 `stopAfter` 或 `exclude` 这些工具——以及必须捕获近似变体时（因为只有精确重复——同一工具、同一参数且与属性顺序无关——才会被检测到），避免使用它。

### 设置阈值与范围

想改变提醒何时触发、否决何时开始或覆盖哪些工具时，用配置挂载插件：

```yaml
- name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # remind at 3 and 5; 8 is the default stopAfter
    stopAfter: 8                 # veto identical calls at this count and beyond
    include: []                  # track every tool; list patterns to track only some
    exclude: [todo_write]        # never track these tools
    argumentsPreviewChars: 500   # cap on arguments shown in the detailed reminder and stop notice
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `thresholds` | `[3, 5, 8]` | 低于 `stopAfter` 时触发提醒的重复次数 |
| `stopAfter` | 最后一个 `thresholds` 项（`8`） | 达到该次数时本插件否决相同调用；之后的相同调用也会被否决 |
| `include` | `[]` | 只跟踪这些工具；空表示所有工具 |
| `exclude` | `[]` | 绝不跟踪这些工具；对它们的调用既不计数也不重置 |
| `argumentsPreviewChars` | `500` | 详细提醒与停止说明中显示多少字符的重复参数 |

无效配置会在启动时以清晰错误失败——空的 `thresholds` 列表、小于 2 的重复次数或 `stopAfter`、非整数或重复的阈值——绝不会静默改变行为。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-repeat-tool-reminder)记录每个受支持的值。

### 你会得到什么

按默认值，以相同参数重复同一调用的模型会在第三次重复时收到简短提醒——先分析上一次结果再调用——在第五次收到详细提醒（列出工具与重复参数），并在第八次被否决：该调用的 post-execute 决策为 `block`，工具结果是停止说明，同一段文本作为带插件来源的上下文注入。agent loop（智能体循环）不会被停止，因此模型仍可选择其他动作或结束任务。新的用户消息会清零计数，因此全新指令绝不会被当作循环。提醒与停止说明出现在重复调用的结果之后、归属于插件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 guard 如何检测重复并投递提醒，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

guard 建立在四项承诺之上：

- **先提醒，再否决。** 低于 `stopAfter` 时，guard 用模型上下文丰富 post-execute 决策，不阻止或改写调用。达到 `stopAfter` 及之后，它仍调用 `next()`，然后返回 `kind: 'block'` 并带上插件来源的停止文本：这会否决重复的工具结果，让循环可以收尾。它不跳过其他监听器、不改写 prompt 以规避 HITL（人在回路）或命令策略，也不停止 agent loop（智能体循环）。
- **在 post-execute 中计数。** 检测运行在 `tools/post-execute` 上，被拒绝的调用同样会经过它；在那里计数让一个监听器即可覆盖所有尝试，无需跨事件状态。
- **精确匹配规范化。** 参数以循环的 `JSON.parse` 输出（或畸形参数 JSON 的原始字符串回退）到达 guard，因此 JSON 的值域就是全部输入域，深度键排序加 `JSON.stringify` 是完整、确定性的同一性判定——不存在 bigint、循环引用或 `undefined` 处理，因为没有输入路径能产生它们。
- **加载时快速失败。** `thresholds`、`stopAfter` 与 `argumentsPreviewChars` 在 `apply` 中校验并抛出错误，绝不回退到默认值。省略 `stopAfter` 时解析为最后一个 `thresholds` 项。

### 检测：重复链

每个 agent 的链以「`(tool name, canonical arguments)`」为键——同一工具且规范化后参数相同（忽略属性顺序）的两次调用计为连续，换成另一条受跟踪调用则把计数重置为 1。链保存在 `WeakMap<Agent, Chain>` 中。

- **不受跟踪的调用对链透明。** 被 `include`／`exclude` 排除的调用既不递增也不重置计数器，因此 `grep X → todo_write → grep X` 在 `todo_write` 被排除时仍算作连续两次 `grep X`——穿插进循环的记录类工具不能掩盖循环。
- **被拒绝的调用也计数。** 检测位于 `tools/post-execute`，被 `tools/pre-execute` 监听器拒绝的调用同样会经过它；模型反复尝试被拒绝的调用，恰恰是需要打破的循环。
- **忽略没有 agent 的调用。** 直接调用 `ctx.tools.execute()` 的调用方没有需要提醒的模型，也没有可作为键的活跃 agent 对象。
- **按 agent 分键，用户提示词时重置。** 一个 agent 的重复绝不会触发另一个 agent 的提醒；用户提示词（`agent/pre-step`）会删除提交该提示词的 agent 链，对象生命周期限制弱引用条目的寿命，无需 dispose（资源释放）监听器。
- **仅驻留内存。** 从持久化恢复的会话以全新链开始——guard 是启发式提醒，而非记录在案的不变量，因此恢复后的提醒延后是可接受的代价。

### 提醒传递

提醒随 post-execute 决策的 `additionalContexts`（来源为 `{kind: 'plugin', plugin: 'repeat-tool-reminder', form: 'notice', summary: '<tool> × <count>'}`）传递，在提醒路径上绝不替换 `content`：用于审计的 `tool/result` 事件仍保留工具自己的输出。循环会缓冲这段上下文，并在该步骤的工具结果之后作为注入的 `user/message` 追加，会话将其渲染为普通的合成用户消息——模型可见、带有来源归属，且无需新会话事件即可从会话日志重建。达到 `stopAfter` 时使用相同的插件来源，但决策为 `block`：`feedback` 成为错误工具结果，停止说明也前置到 `additionalContexts`。guard 始终先通过 `next()` 委派，因此每个下游监听器仍会运行；随后 stop 替换返回的决策。它不绕过 HITL（人在回路）、命令策略或其他守卫。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、快速失败校验、链监听器 |
| — | 不发布运行时不变式伴生入口；链私有于一个 post-execute 监听器。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从工具 waterfall 逐步进入穷尽式配置与 guard 组映射。

- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——本 guard 消费的 `tools/execute` waterfall、`additionalContexts` 与决策形态。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-repeat-tool-reminder)——每个受支持配置字段及其源声明。
- [guard 组映射](../README.zh.md)——同组的 guard 包与循环卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### 首个阈值的上下文消息

#### 模型看到什么

达到第一个配置的连续重复阈值时，对应 agent 会收到下面的提醒。不会添加工具 schema 或正常调用文本。

##### 首个阈值提醒

```markdown
You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.
```

#### Token 影响

达到阈值前为零 token。提醒会作为该 agent 的历史记录保留。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 后续阈值的上下文消息

#### 模型看到什么

达到后续阈值时，agent 会收到下面的详细提醒模板。受上限约束的参数预览严格以 `… (+<omitted> more chars)` 结尾。

##### 后续阈值提醒

```markdown
Repeated tool call detected:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.
```

#### Token 影响

每条提醒都会作为历史记录保留；`argumentsPreviewChars` 限制随数据变化的参数文本长度，而各 agent 仍使用独立计数器。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 停止档的阻止

#### 模型看到什么

达到 `stopAfter` 以及之后每一次相同的连续调用时，对应 agent 会以下面的停止说明作为带插件来源的上下文，并且工具结果是同一段文本的错误。不会添加工具 schema 或正常调用文本。

##### 停止说明

```markdown
Repeated tool call blocked:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
This identical call was blocked because it made no progress. Do not retry this tool with these exact arguments. Inspect prior results and take a different action, or finish the task if enough evidence has been gathered.
```

#### Token 影响

每条停止说明都会作为历史记录保留；`argumentsPreviewChars` 限制随数据变化的参数文本长度。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 guard 何时不合适。它们是当前包约束，不是任务积压。

- **仅精确匹配检测**——规范化是深度键排序，因此近似变体（稍作修改的路径、值内多余的空白）会绕过链；在没有需求证据前，不采用模糊匹配。
- **压缩（compaction）不会重置链**——跨越压缩检查点的链会继续计数。
- **post-execute 否决无法撤销副作用**——`stopAfter` 在调用已经跑完之后阻止工具*结果*；之后的相同调用仍会先执行再被阻止。对轮询类工具使用 `exclude`，不要指望 pre-execute 拒绝。
- **subagent 之间不共享链**——链始终按 agent 隔离；父 agent 与其 subagent 重复相同调用也绝不合并。
- **合理的幂等轮询超过阈值后仍会收到提醒，并在 `stopAfter` 时被否决**——可通过 `thresholds`／`stopAfter`／`exclude` 配置释放压力。
- **提醒只在低于 `stopAfter` 的精确配置次数上触发**——等于或高于 `stopAfter` 的阈值不会再投递提醒，改用停止说明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

[repeat-tool-guard Agent Note](../../../.agents/notes/archived/feature/2026-07-08-repeat-tool-guard.md) 以旧包名记录了原始设计与备选方案；[改名台账](../../../.agents/notes/archived/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md) 记录了改名为 `repeat-tool-reminder` 及其原因。[repeat-tool 停止档 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-05-repeat-tool-stop-gate.zh.md) 记录了已交付插件为何在 `stopAfter` 否决，而不再仅提供建议。

</details>
