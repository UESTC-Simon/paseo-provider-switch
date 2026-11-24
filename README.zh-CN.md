# Paseo Provider 切换与上下文压缩

[English](README.md)

在 **Paseo** 的**同一个对话内**随时切换 **Claude**、**Codex**、**Antigravity** 等底层 Provider，切换时自动压缩上下文（Compact Context）并无缝接管；同时为已有原生对话提供一键压缩迁移能力。

## 核心功能

- **同对话原地切换（`Switchable` 聚合 Provider）**
  - 新建对话选择 **Switchable** Provider 后，可随时通过聊天框工具栏原生的 **Provider** 下拉框或 `/switch <provider> [model]` 命令切换底层 Provider。
  - 切换时自动压缩历史上下文，在时间线中显示原生 `Compacting → Compacted` 压缩标记，实时刷新目标 Provider 的模型与权限模式，并由新 Provider 无缝接管下一轮对话。
  - 底层托管隐藏的 `background: true` 子会话，不污染侧边栏与标签页，将流式回复、推理、工具调用卡片和权限审批全部实时桥接到同一条时间线。
  - 支持 `/compact` 手动压缩当前上下文、A → B → A 来回切换增量交接，以及重启后的完整时间线持久化恢复。
- **已有原生对话一键压缩迁移**
  - 在任意原生对话（Claude / Codex / Antigravity 等）输入框上方提供 **「切换 Provider」** 胶囊按钮及 `/handoff <provider> [model]` 命令。
  - 自动压缩当前对话并在同一工作区创建目标对话并自动跳转聚焦（支持直接迁入 **Switchable**，后续即可在同一对话内自由切换）。
- **低延迟窗口感知压缩引擎**
  - 短对话（≤1,800 字符）直接无损移交（0ms 延迟）。
  - 长对话原样保留最近 N 轮（默认 3 轮），早期历史优先通过 `~/.claude/settings.json` 中的高速 Anthropic 兼容直连接口（DeepSeek 端点默认使用非思考极速模型 `deepseek-chat`）生成结构化交接摘要，异常时自动降级到本地结构化压缩，不阻塞切换。

## 安装

需要 **Paseo 0.17.3 及以上版本**，并在目标守护进程启用插件系统。

直接从 GitHub 安装：

```sh
paseo plugin install github:UESTC-Simon/paseo-provider-switch
```

或从本地目录安装：

```sh
paseo plugin install /absolute/path/to/paseo-provider-switch
```

## 使用方式

### 同对话内原地切换（推荐）

1. 新建对话时选择 **Switchable** 作为 Provider。
2. 对话过程中随时点击聊天框工具栏的 **Provider** 下拉框切换，或输入斜杠命令：
   - `/switch codex`
   - `/switch claude`
   - `/switch antigravity`
   - `/compact`

### 已有原生对话迁移

点击输入框上方的 **「切换 Provider」** 胶囊按钮，或输入 `/handoff switchable` / `/handoff codex`，插件会自动压缩上下文并在同工作区创建新对话并跳转接管。

## 设置

打开 **设置 → 插件 → Provider 切换** 可配置：

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 默认底层 Provider | `antigravity` | 新建 Switchable 对话时默认启动的底层 Provider。 |
| 压缩引擎 | `auto` | 自动（高速直连 API + 本地回退）、仅直连 API 或纯本地结构化压缩（0ms）。 |
| 压缩摘要模型 | `deepseek-chat` | 直连 API 使用的模型。 |
| 完整保留最近轮数 | `3` | 压缩早期历史时，原样保留的最近用户轮数。 |
| 迁移后自动归档旧对话 | `false` | 原生对话一键迁移后是否自动归档原对话。 |

## 开发与测试

```sh
npm ci
npm run typecheck
npm test
```

本地修改后热重载插件：

```sh
paseo plugin reload provider-switch
```

[MIT 协议](LICENSE)
