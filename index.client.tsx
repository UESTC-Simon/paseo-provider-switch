import type {
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { messages } from "./client/i18n";
import { ProviderSwitchSettingsScreen } from "./client/settings-screen";
import { handoffAgentRpc, listSwitchTargetsRpc } from "./shared/protocol";
import { BACKEND_LABEL_KEY, SWITCHABLE_PROVIDER_ID } from "./shared/settings";

interface ObservedAgent {
  id: string;
  workspaceId?: string | null;
  provider?: string;
  background?: boolean;
  labels?: Record<string, string>;
}

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  let availableTargets: Array<{ id: string; label: string }> = [
    { id: SWITCHABLE_PROVIDER_ID, label: "Switchable (In-Chat)" },
    { id: "codex", label: "Codex" },
    { id: "claude", label: "Claude" },
    { id: "antigravity", label: "Antigravity" },
  ];

  async function refreshTargets(): Promise<void> {
    try {
      const result = await client.rpc(listSwitchTargetsRpc, {});
      if (result.providers.length > 0) {
        availableTargets = result.providers;
      }
    } catch {
      // Keep fallback list until daemon responds.
    }
  }

  async function runHandoff(agentId: string, targetProvider: string, targetModel?: string): Promise<void> {
    const result = await client.rpc(handoffAgentRpc, {
      sourceAgentId: agentId,
      targetProvider,
      targetModel,
    });
    for (const composer of client.composers({ agentId: result.newAgentId })) {
      await composer.focus().catch(() => undefined);
    }
  }

  function buildMenuItems(agentId: string, currentProvider: string | undefined): PluginButtonMenuEntry[] {
    const items: PluginButtonMenuEntry[] = [];
    // Put Switchable (In-Chat) first so users can migrate any native chat into in-place switching.
    const sorted = [...availableTargets].sort((a, b) => {
      if (a.id === SWITCHABLE_PROVIDER_ID) return -1;
      if (b.id === SWITCHABLE_PROVIDER_ID) return 1;
      return a.label.localeCompare(b.label);
    });
    for (const target of sorted) {
      if (target.id === currentProvider) continue;
      items.push({
        kind: "item",
        id: `to-${target.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`,
        title:
          target.id === SWITCHABLE_PROVIDER_ID
            ? client.i18n.t(messages, "pill.toSwitchable")
            : client.i18n.t(messages, "pill.toProvider", { provider: target.label }),
        icon: "ArrowLeftRight",
        behavior: {
          kind: "action",
          async onPress() {
            await runHandoff(agentId, target.id);
          },
        },
      });
    }
    return items;
  }

  function registerPill(agent: ObservedAgent): void {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    // Skip Switchable chats (they already have native in-composer Provider switching),
    // background helpers, and internal backend sessions.
    if (
      agent.provider === SWITCHABLE_PROVIDER_ID ||
      agent.background === true ||
      agent.labels?.[BACKEND_LABEL_KEY] === "true"
    ) {
      pills.get(agent.id)?.remove();
      pills.delete(agent.id);
      return;
    }

    const menuItems = buildMenuItems(agent.id, agent.provider);
    if (menuItems.length === 0) return;

    pills.get(agent.id)?.remove();
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "switch-provider",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: messages.message("pill.title"),
          icon: "ArrowLeftRight",
          label: messages.message("pill.label"),
          behavior: {
            kind: "menu",
            items: menuItems,
          },
        },
      }),
    );
  }

  function removeAllPills(): void {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  }

  const removeSettings = client.addSettingsScreen({
    id: "settings",
    title: messages.message("settingsScreen"),
    icon: "ArrowLeftRight",
    Component: ProviderSwitchSettingsScreen,
  });

  const removeSlash = client.addSlashCommand({
    name: "handoff",
    description: messages.message("commands.handoffDesc"),
    argumentHint: messages.message("commands.handoffHint"),
    context: "agent",
    async onSubmit({ args, agent, rpc, composers }) {
      const [targetProvider, targetModel] = args.split(/\s+/).filter(Boolean);
      const target = targetProvider || SWITCHABLE_PROVIDER_ID;
      const result = await rpc(handoffAgentRpc, {
        sourceAgentId: agent.id,
        targetProvider: target,
        targetModel,
      });
      for (const composer of composers({ agentId: result.newAgentId })) {
        await composer.focus().catch(() => undefined);
      }
    },
  });

  const removeCommand = client.addCommandCenterItem({
    id: "open-settings",
    title: messages.message("commands.openSettings"),
    icon: "ArrowLeftRight",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("settings");
    },
  });

  void refreshTargets().then(() => {
    if (lifetime.signal.aborted) return;
    return client.paseo.agents
      .list({ subscribe: {}, signal: lifetime.signal })
      .then(({ subscription }) => {
        subscription.subscribe({
          snapshot: ({ entries }) => {
            removeAllPills();
            for (const { agent } of entries) {
              registerPill(agent as ObservedAgent);
            }
          },
          update: (message) => {
            if (message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "upsert") {
              registerPill(update.agent as ObservedAgent);
              return;
            }
            pills.get(update.agentId)?.remove();
            pills.delete(update.agentId);
          },
        });
      });
  }).catch((error: unknown) => {
    if (!lifetime.signal.aborted) {
      console.error("[provider-switch] Agent observation failed:", error);
    }
  });

  return () => {
    lifetime.abort();
    removeAllPills();
    removeSettings();
    removeSlash();
    removeCommand();
  };
}
