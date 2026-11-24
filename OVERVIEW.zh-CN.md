# Provider 切换与上下文压缩

Provider 切换与上下文压缩提供两种切换能力：通过 Switchable 聚合 Provider 在同一个对话时间线内直接切换 Claude、Codex、Antigravity 等底层 Provider 并自动压缩上下文接管；同时在已有原生对话中提供一键切换按钮和 `/handoff` 命令，自动压缩上下文并无缝迁移接管。

## 使用方式

在 Switchable 对话中，可通过聊天框工具栏的 Provider 下拉控件或输入 `/switch <provider> [model]` 原地切换底层 Provider。切换时时间线会显示原生压缩进度并自动生成交接摘要，由目标 Provider 接管下一轮对话；也可输入 `/compact` 手动压缩当前上下文。

在任意已有原生对话中，点击输入框上方的「切换 Provider」胶囊按钮（或输入 `/handoff <provider>`），即可自动压缩上下文并在同一工作区创建目标对话并自动跳转接管。

## 设置

在「设置 → 插件 → Provider 切换」中可配置 Switchable 默认底层 Provider、压缩引擎（自动高速 API + 本地回退 / 仅直连 API / 纯本地压缩）、压缩模型、完整保留的最近轮数，以及原生对话迁移后是否自动归档旧对话。
