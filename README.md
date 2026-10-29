# dsh-auto-dev

DeepSeek Harness 的 Auto Dev 插件。模型负责实现与排查；插件把真实执行、人工决定和任务记录投影到对话回执、dock 与右侧面板。插件不接管宿主的代理或工作树调度。

## 安装

```sh
git clone <本仓库地址> dsh-auto-dev
dsh plugin --profile <profile> add ./dsh-auto-dev
```

无运行时依赖；客户端包 `lib/client.js` 已随仓库提交，无需构建。安装后重启宿主。

## 使用

安装或修改 host 源码后重启宿主。改客户端需 `npm install` 后 `npm run build:client`，再刷新页面。用户在会话中运行 `/dsh-auto-dev start <需求>` 即授权开始；`work_start` 登记该请求，不重复索取同意。`start` 可接手项目未完成任务；明确另开任务用 `new`。未启用的会话不挂载工具与工艺提示。

默认模式为 `do`，计划按需建立。新输入 `build` 归一为 `do`；历史 `build` 保留原值并按 `do` 解释。`look` 表示查看意图，不代表完整写入沙箱。`auto` / `pm` 验收独立于模式。

## 七个工具

| 入口 | 产出 |
| --- | --- |
| `work_start` | 请求、范围、验收、环境与项目知识摘要 |
| `work_plan` | 可选单元、依赖、分组、当前叶子与备注 |
| `work_submit` | 关联真实执行的阶段结果；继续工作或返回真实等待 |
| `work_status` | summary / executions / board / tasks；执行证据的 callId 来自 executions |
| `work_control` | 控制、record、人工验收、接手、导入导出、快照和知识记录 |
| `work_extend` | 绑定当前任务与具体动作的真实人工决定 |
| `work_env` | 有来源的环境观测、候选、失效与受保护规则 |

具体输入见工具 schema；低频操作见 [operations](skills/auto-dev/references/operations.md)。旧工具名、旧 operation 与历史记录继续可读。普通记录不等于确认。真实未决问题、人工验收、权限或暂停才要求等待。

## 能力与验证入口

| 能力 | 实际入口与输出 | 产物场景 |
| --- | --- | --- |
| 可选计划与模式兼容 | `work_start` → 原始/有效模式、任务；有计划时仍按全部叶子收尾 | S34、S40、S41 |
| 依赖与分组 | `work_plan` → DAG、叶子进度、主题；容器不作工作单元 | S18–S21、S34 |
| 成功证据 | `work_submit` → ledger、检查与 UI 档位；拒绝失败、过期或冒用执行 | S33、S36、S40 |
| 人工决定 | `work_extend` / accept / rework → 有来源的授权或新证据窗口 | S35、S36 |
| 普通记录 | `work_control record` → 目标、回执、问答、方案、经验；旧入口共用 owner | S37、S42 |
| 环境 | `work_env` → runtime.json；观测不能解除受保护规则 | S35、S38 |
| 方法提示 | hook → 当前事件的方法与文档；不要求登记阅读 | S13、S39 |
| 知识复用 | learning / remember → memory.json 或 project-domain.md；后续开工按请求取相关摘要 | S08、S42 |
| 状态与界面 | 共享状态 owner → 工具、命令、回执、dock、右栏 | S22、S31、S41 |
| 交接与恢复 | adopt / export / import / checkpoints / rollback → 历史与快照 | S17、S26、S27、S29 |

工作计划校验唯一 ID、层级与依赖环。只有通过提交验证才能完成叶子。删除未完成叶子不能缩减范围；范围缩减使用有来源的 dropped 路径。UI 单元在提交时按声明的 `static` / `logic` / `browser` 校验，未声明时提示。

检查点使用 `git stash create` 和 `refs/auto-dev-v3/`，不移动 HEAD 或暂存区。回滚覆盖已跟踪的工作区文件，必须有具体授权；不恢复未跟踪文件、数据库、服务或外部副作用。导出的执行记录只是历史，接手会话必须取得当前窗口的新证据。

## 知识与方法

| 存储 | 内容 |
| --- | --- |
| `.auto-dev/runtime.json` | 当前运行事实、来源、失效状态与规则 |
| `.auto-dev/memory.json` | 可复用工程事实、观察、根因记录与修复经验 |
| `.auto-dev/project-domain.md` | 业务术语、规则与决定 |
| 任务已有字段 | 本次目标、问答、回执、方案与进展 |
| `.auto-dev/postmortem.md` | 旧复盘只读兼容；新记录写 memory.json |

未知根因保留为 observation / hypothesis。记录过机制不等于本次已验证。十篇工艺指南按任务选择深度，入口见 [工艺索引](skills/auto-dev/SKILL.md)。patterns 是查阅材料，不是自动学习系统。

## 开发检查

要求 Node.js ≥20。`npm run check` 执行单元测试和真实插件产物场景；`npm run build:client` 构建客户端；`npm run flow` 跑端到端流；`npm run hooks:install` 装 pre-commit 钩子（提交前自动跑检查）。产物场景使用真实插件、工具和状态机，KV 为内存实现；它不能代替隔离宿主及浏览器验收。

本文不宣称已测得 token、效率或自修复收益。
