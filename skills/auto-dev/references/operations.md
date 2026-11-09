# 操作索引

八工具名称不变（另加只读的 `work_recall`）。常用输入由工具 schema 提供；这里补充低频操作和兼容边界。

## 计划与阶段结果

- `work_start`：`request` 保留用户原话；`scope`、`acceptance` 写实际边界。`plan` 可省略，可用数组或 `{units}`。新 `build` 是 `do` 别名。
- `work_plan`：`set/add/group/organize/activate/state/list/note/ask`。`ask` 用 `unit + text`；`done` 由验证后的提交产生。单元可带可选 `kind`：`refactor`、`verification`、`perf`、`test`、`clarify`（只换方法卡）；不写就是普通交付。计划已存在时，不能删去未完成叶子来收尾。
- `work_submit`：`outcome + summary`，其余可选。交付时插件在项目里自己跑一次项目检查（工作区自上次通过后没变就不重跑），红了才打回；修通过一个 bug 而 `.auto-dev/incidents.md` 没写，也打回一次。`claims` 只是你的说明，插件不靠它判断。提交后的 `waiting` 与 `continueAuthorized` 表示是否继续；普通阶段结果继续已授权工作。

## 普通记录

`work_control operation:record` 可用 `payload:{kind,...}` 或 `entries:[...]`。整批输入先校验。

| kind | 内容 |
| --- | --- |
| goal | `text`，可附 `why` |
| receipt | `text`，表示理解，不表示用户确认 |
| clarify | `asked:[{question}]`（兼容 `q`）、`answers:[{q,answer}]`、`assumption` |
| learning | `text` 或 `symptom/cause/change/finding/prevention/ruledOut/check/lesson`；未知原因可省略 |

只记录影响目标、验收、下一步或复用的信息。真实未答问题且无继续假设才等待。更好的做法直接在对话里问用户，定了再登记。旧 `goal/receipt/clarify/alternative/postmortem` 入口保留（`alternative` 只记历史）；`postmortem` 现在写 memory，不再追加旧复盘文件。

## 控制与验收

`pause/resume/cancel/continue` 沿用状态机。`accept/rework` 由交付之后用户自己的回话决定，不用抄原话；用户说了不，accept 什么都不动。`pm` 完成叶子后进入 `review_ready`，不能把模型提交当人工验收。`status` 是兼容读取入口，事实与 `work_status` 相同。

## 接手与跨机

- `adopt`：可指定 `taskId`，也可接手本项目最近任务。跨会话重建证据窗口；旧 ledger 保留为历史。
- `export`：返回任务坐标与历史。
- `import`：`payload` 接收导出对象；导入单元重置待办，执行记录不携带可用证明。检查点对象必须在目标仓库实际存在。
- 子代理和工作树由宿主管理；不要把导出当成调度器。

## 检查点与回滚

`checkpoints` 列出已有坐标。`rollback` 用 `target`（latest / before / ref / commit）或 `label`。恢复会覆盖已跟踪工作区文件；先取得针对确切 `rollback <ref>` 的授权。检查点不保证恢复未跟踪文件、服务、数据库或外部系统。

## 项目知识

复盘写 `.auto-dev/incidents.md`（每条 `## 标题` 开头，`work_recall` 按标题列、按词搜，含别的项目的）、业务口径写 `.auto-dev/project-domain.md`，用普通编辑工具即可；`remember` 仍可用，但不是必需。

运行端口、命令、GUI、禁令属于 `work_env`。`observe` 只接受成功当前执行的 `callId` 或真实用户 `quote/sourceSeq`。推断用 `propose`。受保护规则的确认和撤销必须有明确用户来源；通用授权不能覆盖禁令。

知识位置及历史兼容见 [记忆](craft/memory.md)。
