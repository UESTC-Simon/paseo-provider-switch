# Paseo Provider Switch & Compact

[简体中文](README.zh-CN.md)

Switch between **Claude**, **Codex**, **Antigravity**, and other enabled Paseo providers inside the **same conversation** with automatic context compaction — plus one-click compact handoff for existing native chats.

## Features

- **Same-Chat Provider Switching (`Switchable` provider)**
  - Start a chat with the **Switchable** provider and switch the underlying backend provider anytime from the native composer **Provider** dropdown or with `/switch <provider> [model]`.
  - Automatically compacts conversation history on switch, displays native `Compacting → Compacted` markers in the timeline, updates models/modes/thinking options live, and seamlessly hands over to the target provider.
  - Streams replies, reasoning, tool calls, and permission approvals into a single unified timeline using hidden `background: true` backend sessions.
  - Supports `/compact` to manually compact context without switching providers, incremental switch-back (A → B → A), and persistence across daemon restarts.
- **One-Click Native Chat Migration**
  - Adds a **Switch** composer pill and `/handoff <provider> [model]` command on existing native chats (Claude, Codex, Antigravity, etc.).
  - Compacts the conversation and opens a continuation chat in the same workspace (optionally migrating straight into **Switchable** for future in-place switching).
- **Fast Window-Aware Context Compaction**
  - Short histories (≤1,800 chars) pass through verbatim with zero external latency.
  - Longer histories preserve the most recent turns verbatim while summarizing earlier history via a fast direct Anthropic-compatible API (reads `~/.claude/settings.json`, defaults to `deepseek-chat` on DeepSeek endpoints), with automatic structured local fallback so switching never blocks.

## Installation

Requires **Paseo 0.17.3 or later** with plugins enabled on the daemon host.

Install directly from GitHub:

```sh
paseo plugin install github:UESTC-Simon/paseo-provider-switch
```

Or from a local checkout:

```sh
paseo plugin install /absolute/path/to/paseo-provider-switch
```

## Usage

### In-Chat Switching (Recommended)

1. Create a new conversation and select **Switchable** as the provider.
2. Switch backend providers anytime from the composer **Provider** selector, or run:
   - `/switch codex`
   - `/switch claude`
   - `/switch antigravity`
   - `/compact`

### Existing Native Chats

Click the **Switch** pill above the composer (or run `/handoff switchable` / `/handoff codex`). The plugin compacts the conversation, creates the continuation chat in the same workspace, and focuses it automatically.

## Settings

Open **Settings → Plugins → Provider Switch** to configure:

| Setting | Default | Description |
| --- | --- | --- |
| Default backend provider | `antigravity` | Initial backend provider for new Switchable chats. |
| Compaction engine | `auto` | `auto` (fast direct API + local fallback), `direct`, or `fallback` (0ms local structured compaction). |
| Compaction model | `deepseek-chat` | Model used by the direct compaction API. |
| Recent turns kept verbatim | `3` | Number of newest user turns kept intact alongside the compacted summary. |
| Archive old chat after handoff | `false` | Automatically archive the source native chat after migrating. |

## Development

```sh
npm ci
npm run typecheck
npm test
```

After editing a local checkout, reload the plugin in Paseo:

```sh
paseo plugin reload provider-switch
```

[MIT License](LICENSE)
