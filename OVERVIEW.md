# Provider Switch & Compact

Provider Switch & Compact adds a Switchable provider that lets you switch between Claude, Codex, Antigravity, and other enabled providers inside the same conversation with automatic context compaction, and adds a one-click Switch pill and `/handoff` command to migrate existing native chats.

## How it works

In a Switchable chat, choose the active backend provider from the composer Provider control or run `/switch <provider> [model]`. Switching compacts the conversation history, shows a native compaction marker in the timeline, and primes the target provider to take over on the next turn. Run `/compact` to compact context without switching providers.

In any existing native chat, click the Switch pill above the composer (or run `/handoff <provider>`) to compact the conversation and open a continuation chat on Switchable or another native provider in the same workspace.

## Settings

Under Settings -> Plugins -> Provider Switch, choose the default backend provider for new Switchable chats, the compaction engine (Auto fast API with local fallback, direct API only, or local structured compaction), compaction model, number of recent turns kept verbatim, and whether native handoffs archive the source chat.
