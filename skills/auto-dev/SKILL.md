---
name: auto-dev-craft
description: Practical methods for Auto Dev delivery, debugging, impact analysis, verification, UI, review, release and project knowledge. Read the relevant guide when its situation occurs; depth follows the task.
---

# Auto Dev 工艺索引

开发任务默认用 `do`，计划按需要建立。`look` 表示查看意图；历史 `build` 按 `do` 执行。人工验收 `pm` 与自动验收 `auto` 独立于模式。

## 入口与产出

| 场景 | 工具 | 产出 |
| --- | --- | --- |
| 已授权的请求 | `work_start` | 任务、范围、验收及已有项目知识 |
| 需要拆分、依赖或分组 | `work_plan` | 可选单元计划、当前叶子 |
| 有阶段结果 | `work_submit` | 证据关联、进度、下一步或真实等待 |
| 读状态或找执行证据 | `work_status` | summary / executions / board / tasks |
| 控制、普通记录、接手或交接 | `work_control` | 状态、记录或快照；见 [低频操作](references/operations.md) |
| 缺能力或要放宽检查 | `work_extend` | 告诉你该问用户什么；不可逆操作不用它：插件先拦一次，你问用户，他的回话决定 |
| 观察或更新运行环境 | `work_env` | `.auto-dev/runtime.json` 的事实、候选与规则 |

## 按当前问题读

| 当前问题 | 方法 |
| --- | --- |
| 如何证明结果 | [验证](references/craft/verification.md) |
| 界面与真实交互 | [界面](references/craft/gui.md) |
| 失败与根因 | [排障](references/craft/debug.md) |
| 调用方与改动范围 | [影响分析](references/craft/impact.md) |
| 改多少、要不要新抽象 | [实现取舍](references/craft/simplicity.md) |
| 交付切分 | [交付](references/craft/delivery.md) |
| 影响实现的歧义 | [访谈](references/craft/interview.md) |
| 用户行为与业务规则 | [行为场景](references/craft/bdd.md) |
| 自审或独立审查 | [审查](references/craft/review.md) |
| 正式发布准备 | [发布](references/craft/release.md) |
| 可复用知识与交接 | [记忆](references/craft/memory.md) |
| 语言或平台做法 | [patterns 索引](references/patterns/README.md)，以实际内容为准 |

代码负责校验、权限与持久化；方法提示提供当前可执行动作。只读有用的部分，不登记阅读。具体输入以七工具 schema 为准。记录不是确认，提示不是完成，历史执行不是本会话证明。

宿主负责多代理与工作树。本插件没有独立调度器，也不宣称 patterns 会自动学习。
