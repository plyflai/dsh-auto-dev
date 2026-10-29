# 项目知识

有可复用发现时记录；日常进度和临时决定留在任务中。无需每轮登记。

| 内容 | owner / 文件 | 复用边界 |
| --- | --- | --- |
| 端口、运行命令、GUI、禁令与锁 | `work_env` / `.auto-dev/runtime.json` | 可能过期；stale 后重新观察；保护规则仍需人工来源 |
| 工程事实、故障观察与机制 | `remember` 或 `record learning` / `.auto-dev/memory.json` | 已记录不等于已验证；复用前核对条件 |
| 业务术语、规则与决定 | `remember target:domain` / `.auto-dev/project-domain.md` | 保留业务来源；探针结果不能推导用户意图 |
| 当前目标、理解、待答、选择与结果 | 当前 task / ledger | 不复制成耐久事实或同意 |
| 旧复盘 | `.auto-dev/postmortem.md` | 只读历史，`legacy-unverified`；不迁移、不追加 |

## 工程教训

记录实际症状。原因未知时省略机制或明确未知，保留观察、假设和辨别办法；不得补造因果。原因有证据支持时记录机制与修复，但后续仍核对适用条件。

`learning` 可含 `symptom/cause/change/finding/prevention` 或简短 `text`。新记录写 memory；旧 `postmortem` 调用是兼容适配器。相同知识合并，摘要优先选择与当前请求相关的内容。

运行环境更新只写 runtime，不把临时端口复制到工程事实。patterns 是可查资料，当前插件不自动从复盘生成或晋升模式。交接使用真实文件和任务历史，并说明证据窗口、未知项和下一动作。
