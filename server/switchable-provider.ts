import type { PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem, JsonValue } from "@getpaseo/protocol/agent-types";
import {
  negotiateProviderCapabilities,
  PROVIDER_PROTOCOL_VERSION,
  type ProviderCatalog,
  type ProviderCommand,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderMode,
  type ProviderModel,
  type ProviderOptionControl,
  type ProviderPermissionRequest,
  type ProviderPersistence,
  type ProviderPrompt,
  type ProviderRegistration,
  type ProviderThinkingOption,
  type ProviderTimelineItem,
  type ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import {
  AGENT_TEAM_ROLE_LABEL_KEY,
  AGENT_TEAM_ROLE_WORKER,
  BACKEND_LABEL_KEY,
  BACKEND_LABEL_VALUE,
  SWITCHABLE_PROVIDER_ID,
  type SwitchSettings,
} from "../shared/settings";
import { type CompactEntry, compactHistory, wrapHandoffPrompt } from "./compactor";

const SUPPORTED_CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "session.configure",
  "session.persistence",
  "permission",
] as const;

const SESSION_COMMANDS: ProviderCommand[] = [
  {
    name: "switch",
    description: "Switch active backend provider in this chat with automatic context compaction",
    argumentHint: "<provider> [model]",
    kind: "command",
  },
  {
    name: "compact",
    description: "Compact conversation context now and prime the active provider",
    argumentHint: "",
    kind: "command",
  },
];

interface PersistedReplayItem {
  id: string;
  item: ProviderTimelineItem;
}

interface SwitchablePersistenceData {
  activeBackend: string;
  activeModel?: string;
  activeMode?: string;
  activeThinking?: string;
  backendAgents: Record<string, string>;
  backendWatermarks: Record<string, number>;
  history: CompactEntry[];
  replayItems: PersistedReplayItem[];
  pendingHandoff?: string;
}

interface ActiveSession {
  sessionId: string;
  cwd: string;
  activeBackend: string;
  activeModel?: string;
  activeMode?: string;
  activeThinking?: string;
  backendAgents: Record<string, string>;
  backendWatermarks: Record<string, number>;
  history: CompactEntry[];
  replayItems: PersistedReplayItem[];
  pendingHandoff?: string;
  running: boolean;
  activeTurnId?: string;
  activeBackendHandle?: PaseoAgentHandle;
  cancelActiveTurn?: () => Promise<void>;
  permissionMap: Map<string, { backendAgentId: string; requestId: string }>;
  models: ProviderModel[];
  modes: ProviderMode[];
  thinkingOptions: ProviderThinkingOption[];
  availableBackends: Array<{ id: string; label: string }>;
}

const FALLBACK_BACKENDS: Array<{ id: string; label: string }> = [
  { id: "antigravity", label: "Antigravity" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
];

export interface SwitchableProviderDeps {
  getPaseo(): PaseoApi | null;
  getSettings(): SwitchSettings;
}

export function createSwitchableProvider(deps: SwitchableProviderDeps): ProviderRegistration {
  return {
    id: SWITCHABLE_PROVIDER_ID,
    label: "Switchable",
    description: "Switch between Claude, Codex, Antigravity, and other providers inside the same chat with automatic context compaction.",
    icon: "assets/icon.svg",
    async status() {
      return { available: true };
    },
    async connect(request) {
      const capabilities = negotiateProviderCapabilities(request.capabilities, SUPPORTED_CAPABILITIES);
      return createConnection(capabilities, deps);
    },
  };
}

function createConnection(
  capabilities: readonly string[],
  deps: SwitchableProviderDeps,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, ActiveSession>();

  function emit(event: ProviderEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  async function discoverBackends(paseo: PaseoApi | null): Promise<Array<{ id: string; label: string }>> {
    if (!paseo) return [...FALLBACK_BACKENDS];
    try {
      const result = await paseo.providers.listAvailable();
      const found = result.providers
        .filter((entry) => entry.available && entry.provider !== SWITCHABLE_PROVIDER_ID)
        .map((entry) => ({
          id: entry.provider,
          label: formatProviderLabel(entry.provider),
        }));
      return found.length > 0 ? found : [...FALLBACK_BACKENDS];
    } catch {
      return [...FALLBACK_BACKENDS];
    }
  }

  async function loadBackendCatalog(
    paseo: PaseoApi | null,
    backendId: string,
    cwd?: string,
  ): Promise<{
    models: ProviderModel[];
    modes: ProviderMode[];
    thinkingOptions: ProviderThinkingOption[];
    defaultModel?: string;
    defaultMode?: string;
    defaultThinkingOption?: string;
  }> {
    if (!paseo) {
      return { models: [], modes: [], thinkingOptions: [] };
    }
    const [modelsResult, modesResult] = await Promise.all([
      paseo.providers.listModels(backendId, cwd ? { cwd } : undefined).catch(() => null),
      paseo.providers.listModes(backendId, cwd ? { cwd } : undefined).catch(() => null),
    ]);
    const models: ProviderModel[] = (modelsResult?.models ?? [])
      .filter((m) => m.isSelectable !== false)
      .map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        isDefault: m.isDefault,
        contextWindowMaxTokens: m.contextWindowMaxTokens,
        thinkingOptions: m.thinkingOptions?.map((opt) => ({
          id: opt.id,
          label: opt.label,
          description: opt.description,
          isDefault: opt.isDefault,
        })),
        defaultThinkingOptionId: m.defaultThinkingOptionId,
      }));
    const modes: ProviderMode[] = (modesResult?.modes ?? []).map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      icon: m.icon,
      colorTier: m.colorTier,
    }));
    const defaultModelObj = models.find((m) => m.isDefault) ?? models[0];
    const thinkingOptions = defaultModelObj?.thinkingOptions ?? [];
    const defaultThinkingOption =
      defaultModelObj?.defaultThinkingOptionId ??
      thinkingOptions.find((t) => t.isDefault)?.id ??
      thinkingOptions[0]?.id;
    return {
      models,
      modes,
      thinkingOptions,
      defaultModel: defaultModelObj?.id,
      defaultMode: modes[0]?.id,
      defaultThinkingOption,
    };
  }

  function buildSessionConfig(session: ActiveSession): ProviderConfigState {
    const choices = ensureBackendChoice(session.availableBackends, session.activeBackend);
    const controls: ProviderOptionControl[] = [
      {
        type: "select",
        key: "backend",
        label: "Provider",
        icon: "ArrowLeftRight",
        defaultValue: session.activeBackend,
        choices: choices.map((c) => ({ value: c.id, label: c.label })),
      },
    ];
    return {
      model: session.activeModel,
      mode: session.activeMode,
      thinkingOption: session.activeThinking,
      models: session.models,
      modes: session.modes,
      thinkingOptions: session.thinkingOptions,
      controls,
      providerOptions: {
        backend: session.activeBackend,
      },
    };
  }

  function toPersistence(session: ActiveSession): ProviderPersistence {
    const data: SwitchablePersistenceData = {
      activeBackend: session.activeBackend,
      activeModel: session.activeModel,
      activeMode: session.activeMode,
      activeThinking: session.activeThinking,
      backendAgents: session.backendAgents,
      backendWatermarks: session.backendWatermarks,
      history: session.history.slice(-160),
      replayItems: session.replayItems.slice(-240),
      pendingHandoff: session.pendingHandoff,
    };
    return {
      version: 1,
      data: data as unknown as JsonValue,
    };
  }

  function recordReplayItem(session: ActiveSession, item: ProviderTimelineItem): void {
    const existingIndex = session.replayItems.findIndex((entry) => entry.id === item.id);
    if (existingIndex >= 0) {
      session.replayItems[existingIndex] = { id: item.id, item };
    } else {
      session.replayItems.push({ id: item.id, item });
    }
    emit({ type: "timeline.item", sessionId: session.sessionId, item });
  }

  async function switchBackendInSession(
    session: ActiveSession,
    targetBackend: string,
    requestedModel?: string,
  ): Promise<void> {
    if (session.running) {
      throw new Error("Wait for the current turn to finish before switching providers.");
    }
    const normalizedTarget = targetBackend.trim().toLowerCase();
    if (!normalizedTarget || normalizedTarget === SWITCHABLE_PROVIDER_ID) {
      throw new Error(`Invalid target provider: ${targetBackend}`);
    }

    const paseo = deps.getPaseo();
    const settings = deps.getSettings();
    const previousBackend = session.activeBackend;
    const isSameBackend = normalizedTarget === previousBackend;

    // Record watermark for the previous backend before leaving it.
    session.backendWatermarks[previousBackend] = session.history.length;

    let noteDetail = "";
    if (session.history.length > 0 && !isSameBackend) {
      const compactId = `compact:${randomUUID()}`;
      emit({
        type: "timeline.item",
        sessionId: session.sessionId,
        item: {
          type: "compaction",
          id: compactId,
          status: "loading",
          trigger: "auto",
        },
      });

      const hasExistingTargetSession = Boolean(session.backendAgents[normalizedTarget]);
      const lastWatermark = session.backendWatermarks[normalizedTarget] ?? 0;
      const entriesToCompact =
        hasExistingTargetSession && lastWatermark > 0 && lastWatermark < session.history.length
          ? session.history.slice(lastWatermark)
          : session.history;

      const compacted = await compactHistory(entriesToCompact, settings, {
        fromProvider: previousBackend,
        toProvider: normalizedTarget,
      });

      recordReplayItem(session, {
        type: "compaction",
        id: compactId,
        status: "completed",
        trigger: "auto",
      });
      if (compacted.briefing) {
        session.pendingHandoff = compacted.briefing;
      }
      noteDetail = ` · compacted ${compacted.entryCount} items in ${compacted.durationMs}ms (${compacted.compactorUsed})`;
    }

    session.availableBackends = await discoverBackends(paseo);
    const catalog = await loadBackendCatalog(paseo, normalizedTarget, session.cwd);
    session.activeBackend = normalizedTarget;
    session.models = catalog.models;
    session.modes = catalog.modes;

    const chosenModel =
      requestedModel && catalog.models.some((m) => m.id === requestedModel)
        ? requestedModel
        : requestedModel || catalog.defaultModel;
    session.activeModel = chosenModel;
    const modelMeta = catalog.models.find((m) => m.id === chosenModel);
    session.thinkingOptions = modelMeta?.thinkingOptions ?? catalog.thinkingOptions;
    session.activeThinking =
      modelMeta?.defaultThinkingOptionId ??
      session.thinkingOptions.find((t) => t.isDefault)?.id ??
      session.thinkingOptions[0]?.id;
    session.activeMode = catalog.defaultMode;

    if (!isSameBackend) {
      recordReplayItem(session, {
        type: "notification",
        id: `switch:${randomUUID()}`,
        level: "info",
        message: `Switched provider: ${formatProviderLabel(previousBackend)} → ${formatProviderLabel(normalizedTarget)}${chosenModel ? ` (${chosenModel})` : ""}${noteDetail}`,
      });
    }

    emit({
      type: "session.config",
      sessionId: session.sessionId,
      config: buildSessionConfig(session),
    });
    emit({
      type: "session.persistence",
      sessionId: session.sessionId,
      persistence: toPersistence(session),
    });
  }

  async function runManualCompact(session: ActiveSession): Promise<void> {
    if (session.running) {
      throw new Error("Wait for the current turn to finish before compacting.");
    }
    if (session.history.length === 0) {
      recordReplayItem(session, {
        type: "notification",
        id: `compact-empty:${randomUUID()}`,
        level: "info",
        message: "Nothing to compact yet.",
      });
      return;
    }
    const settings = deps.getSettings();
    const compactId = `compact:${randomUUID()}`;
    emit({
      type: "timeline.item",
      sessionId: session.sessionId,
      item: {
        type: "compaction",
        id: compactId,
        status: "loading",
        trigger: "manual",
      },
    });
    const compacted = await compactHistory(session.history, settings, {
      fromProvider: session.activeBackend,
      toProvider: session.activeBackend,
    });
    recordReplayItem(session, {
      type: "compaction",
      id: compactId,
      status: "completed",
      trigger: "manual",
    });
    // Reset current backend handle so next turn starts fresh with compacted context.
    delete session.backendAgents[session.activeBackend];
    session.pendingHandoff = compacted.briefing;
    recordReplayItem(session, {
      type: "notification",
      id: `compact-done:${randomUUID()}`,
      level: "info",
      message: `Compacted ${compacted.entryCount} items in ${compacted.durationMs}ms (${compacted.compactorUsed}). Next message will use the fresh compacted context.`,
    });
    emit({
      type: "session.persistence",
      sessionId: session.sessionId,
      persistence: toPersistence(session),
    });
  }

  async function ensureBackendAgent(
    session: ActiveSession,
    paseo: PaseoApi,
  ): Promise<PaseoAgentHandle> {
    const existingId = session.backendAgents[session.activeBackend];
    if (existingId) {
      const ref = paseo.agents.ref(existingId);
      const snapshot = await ref.refresh().catch(() => null);
      if (snapshot && !snapshot.agent.archivedAt) {
        return ref;
      }
      delete session.backendAgents[session.activeBackend];
    }

    const providerSpec = session.activeModel
      ? `${session.activeBackend}/${session.activeModel}`
      : session.activeBackend;
    const created = await paseo.agents.create({
      config: {
        provider: providerSpec,
        modeId: session.activeMode || undefined,
        thinkingOptionId: session.activeThinking || undefined,
      },
      cwd: session.cwd,
      background: true,
      title: `[Switchable:${session.activeBackend}]`,
      labels: {
        [BACKEND_LABEL_KEY]: BACKEND_LABEL_VALUE,
        [AGENT_TEAM_ROLE_LABEL_KEY]: AGENT_TEAM_ROLE_WORKER,
      },
    });
    session.backendAgents[session.activeBackend] = created.id;
    emit({
      type: "session.persistence",
      sessionId: session.sessionId,
      persistence: toPersistence(session),
    });
    return created;
  }

  async function handlePrompt(session: ActiveSession, prompt: ProviderPrompt): Promise<void> {
    if (prompt.input.type === "command") {
      const cmd = prompt.input.name.trim().toLowerCase();
      const args = prompt.input.arguments.trim();
      try {
        if (cmd === "switch") {
          const [providerArg, modelArg] = args.split(/\s+/).filter(Boolean);
          if (!providerArg) {
            throw new Error("Usage: /switch <provider> [model] (e.g. /switch codex or /switch claude)");
          }
          await switchBackendInSession(session, providerArg, modelArg);
          emit({
            type: "session.prompt_result",
            sessionId: session.sessionId,
            clientMessageId: prompt.clientMessageId,
            result: { type: "completed" },
          });
          return;
        }
        if (cmd === "compact") {
          await runManualCompact(session);
          emit({
            type: "session.prompt_result",
            sessionId: session.sessionId,
            clientMessageId: prompt.clientMessageId,
            result: { type: "completed" },
          });
          return;
        }
        throw new Error(`Unknown command /${cmd}`);
      } catch (error) {
        emit({
          type: "session.prompt_result",
          sessionId: session.sessionId,
          clientMessageId: prompt.clientMessageId,
          result: {
            type: "failed",
            error: { message: error instanceof Error ? error.message : String(error) },
          },
        });
        return;
      }
    }

    if (session.running) {
      emit({
        type: "session.prompt_result",
        sessionId: session.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: {
          type: "failed",
          error: { message: "A turn is already running. Wait for it to finish or stop it first." },
        },
      });
      return;
    }

    const paseo = deps.getPaseo();
    if (!paseo) {
      emit({
        type: "session.prompt_result",
        sessionId: session.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: {
          type: "failed",
          error: { message: "Daemon API is not ready yet. Send the message again in a moment." },
        },
      });
      return;
    }

    const userText = extractPromptText(prompt);
    const turnId = randomUUID();
    session.running = true;
    session.activeTurnId = turnId;

    recordReplayItem(session, {
      type: "user_message",
      id: `user:${turnId}`,
      text: userText,
      clientMessageId: prompt.clientMessageId,
    });
    session.history.push({ role: "user", text: userText });

    emit({
      type: "session.prompt_result",
      sessionId: session.sessionId,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    emit({ type: "session.turn", sessionId: session.sessionId, turnId, state: "started" });

    let unsubscribeTimeline: (() => void) | null = null;
    let assistantChunks = new Map<string, string>();
    const toolSummaries: string[] = [];
    let itemSeq = 0;
    const itemIdByKey = new Map<string, string>();

    try {
      const backend = await ensureBackendAgent(session, paseo);
      session.activeBackendHandle = backend;

      const outboundText = session.pendingHandoff
        ? wrapHandoffPrompt(session.pendingHandoff, userText)
        : userText;

      let resolveTurnDone!: (outcome: { state: "completed" | "failed" | "canceled"; error?: string }) => void;
      const turnDone = new Promise<{ state: "completed" | "failed" | "canceled"; error?: string }>((resolve) => {
        resolveTurnDone = resolve;
      });
      let settled = false;
      const finish = (outcome: { state: "completed" | "failed" | "canceled"; error?: string }) => {
        if (settled) return;
        settled = true;
        resolveTurnDone(outcome);
      };

      const sub = backend.timeline.subscribe((ev) => {
        if (ev.event.type === "timeline") {
          const item = ev.event.item;
          if (item.type === "user_message") return;
          const mapped = mapBackendTimelineItem(
            item,
            turnId,
            () => `seg:${turnId}:${itemSeq++}`,
            itemIdByKey,
          );
          if (!mapped) return;
          if (mapped.type === "assistant_message") {
            assistantChunks.set(mapped.id, mapped.text);
          } else if (mapped.type === "tool_call" && mapped.status === "completed") {
            toolSummaries.push(`${mapped.name} (${mapped.status})`);
          }
          recordReplayItem(session, mapped);
          return;
        }
        if (ev.event.type === "permission_requested") {
          const req = ev.event.request;
          const mappedId = `${backend.id}:${req.id}`;
          session.permissionMap.set(mappedId, { backendAgentId: backend.id, requestId: req.id });
          emit({
            type: "session.permission",
            sessionId: session.sessionId,
            request: mapPermissionRequest(req, mappedId),
          });
          return;
        }
        if (ev.event.type === "permission_resolved") {
          const mappedId = `${backend.id}:${ev.event.requestId}`;
          session.permissionMap.delete(mappedId);
          emit({
            type: "session.permission_resolved",
            sessionId: session.sessionId,
            permissionId: mappedId,
          });
          return;
        }
        if (ev.event.type === "turn_completed") {
          if (ev.event.usage) {
            emit({
              type: "session.usage",
              sessionId: session.sessionId,
              turnId,
              usage: ev.event.usage,
            });
          }
          finish({ state: "completed" });
          return;
        }
        if (ev.event.type === "turn_failed") {
          finish({ state: "failed", error: ev.event.error });
          return;
        }
        if (ev.event.type === "turn_canceled") {
          finish({ state: "canceled", error: ev.event.reason });
          return;
        }
      });
      unsubscribeTimeline = () => sub();
      await sub.ready;

      session.cancelActiveTurn = async () => {
        finish({ state: "canceled", error: "Interrupted by user" });
        // Archive or reload isn't needed if daemon supports cancel; fallback to reload to abort cleanly.
        await backend.reload().catch(() => undefined);
      };

      await backend.send(outboundText);
      // Clear pending handoff once backend accepted the turn.
      session.pendingHandoff = undefined;

      const outcome = await turnDone;

      for (const summary of toolSummaries.slice(-12)) {
        session.history.push({ role: "tool", text: summary });
      }
      const combinedAssistant = Array.from(assistantChunks.values()).join("\n").trim();
      if (combinedAssistant) {
        session.history.push({
          role: "assistant",
          text: combinedAssistant,
          provider: session.activeBackend,
        });
      }
      session.backendWatermarks[session.activeBackend] = session.history.length;

      if (outcome.state === "completed") {
        emit({ type: "session.turn", sessionId: session.sessionId, turnId, state: "completed" });
      } else if (outcome.state === "canceled") {
        emit({ type: "session.turn", sessionId: session.sessionId, turnId, state: "canceled" });
      } else {
        emit({
          type: "session.turn",
          sessionId: session.sessionId,
          turnId,
          state: "failed",
          error: { message: outcome.error ?? "Backend turn failed" },
        });
      }

      emit({
        type: "session.persistence",
        sessionId: session.sessionId,
        persistence: toPersistence(session),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordReplayItem(session, {
        type: "error",
        id: `error:${turnId}`,
        message,
      });
      emit({
        type: "session.turn",
        sessionId: session.sessionId,
        turnId,
        state: "failed",
        error: { message },
      });
    } finally {
      unsubscribeTimeline?.();
      session.running = false;
      session.activeTurnId = undefined;
      session.cancelActiveTurn = undefined;
      session.activeBackendHandle = undefined;
    }
  }

  return {
    version: PROVIDER_PROTOCOL_VERSION,
    capabilities,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      for (const session of sessions.values()) {
        await session.cancelActiveTurn?.().catch(() => undefined);
      }
      sessions.clear();
      listeners.clear();
    },
    async send(input: ProviderInput) {
      switch (input.type) {
        case "catalog": {
          const paseo = deps.getPaseo();
          const settings = deps.getSettings();
          const backends = await discoverBackends(paseo);
          const defaultBackend =
            backends.find((b) => b.id === settings.defaultBackendProvider)?.id ??
            backends[0]?.id ??
            "antigravity";
          const backendCat = await loadBackendCatalog(paseo, defaultBackend, input.cwd);
          const catalog: ProviderCatalog = {
            models: backendCat.models,
            modes: backendCat.modes,
            thinkingOptions: backendCat.thinkingOptions,
            defaultModel: backendCat.defaultModel,
            defaultMode: backendCat.defaultMode,
            defaultThinkingOption: backendCat.defaultThinkingOption,
          };
          emit({ type: "catalog", requestId: input.requestId, catalog });
          return;
        }

        case "session.open": {
          const paseo = deps.getPaseo();
          const settings = deps.getSettings();
          const persisted = parsePersistence(input.persistence);
          const availableBackends = await discoverBackends(paseo);
          const requestedOptionBackend =
            typeof input.config.providerOptions?.backend === "string"
              ? input.config.providerOptions.backend
              : undefined;
          const activeBackend =
            persisted?.activeBackend ??
            requestedOptionBackend ??
            availableBackends.find((b) => b.id === settings.defaultBackendProvider)?.id ??
            availableBackends[0]?.id ??
            "antigravity";

          const backendCat = await loadBackendCatalog(paseo, activeBackend, input.config.cwd);
          const activeModel =
            persisted?.activeModel ?? input.config.model ?? backendCat.defaultModel;
          const activeMode =
            persisted?.activeMode ?? input.config.mode ?? backendCat.defaultMode;
          const modelMeta = backendCat.models.find((m) => m.id === activeModel);
          const thinkingOptions = modelMeta?.thinkingOptions ?? backendCat.thinkingOptions;
          const activeThinking =
            persisted?.activeThinking ??
            input.config.thinkingOption ??
            modelMeta?.defaultThinkingOptionId ??
            thinkingOptions[0]?.id;

          const session: ActiveSession = {
            sessionId: input.sessionId,
            cwd: input.config.cwd,
            activeBackend,
            activeModel,
            activeMode,
            activeThinking,
            backendAgents: persisted?.backendAgents ?? {},
            backendWatermarks: persisted?.backendWatermarks ?? {},
            history: persisted?.history ?? [],
            replayItems: persisted?.replayItems ?? [],
            pendingHandoff: persisted?.pendingHandoff,
            running: false,
            permissionMap: new Map(),
            models: backendCat.models,
            modes: backendCat.modes,
            thinkingOptions,
            availableBackends,
          };
          sessions.set(input.sessionId, session);

          emit({
            type: "session.opened",
            requestId: input.requestId,
            sessionId: input.sessionId,
            capabilities,
            restoration: "core",
            persistence: toPersistence(session),
            cwd: input.config.cwd,
          });
          emit({
            type: "session.config",
            sessionId: input.sessionId,
            config: buildSessionConfig(session),
          });
          emit({
            type: "session.commands",
            sessionId: input.sessionId,
            commands: SESSION_COMMANDS,
          });
          if (input.history === "replay") {
            for (const entry of session.replayItems) {
              emit({ type: "timeline.item", sessionId: input.sessionId, item: entry.item });
            }
          }
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          return;
        }

        case "session.configure": {
          const session = sessions.get(input.sessionId);
          if (!session) {
            emit({
              type: "request.failed",
              requestId: input.requestId,
              error: { message: "Session not found" },
            });
            return;
          }
          try {
            const nextBackend = input.changes.providerOptions?.backend;
            if (typeof nextBackend === "string" && nextBackend !== session.activeBackend) {
              await switchBackendInSession(
                session,
                nextBackend,
                typeof input.changes.model === "string" ? input.changes.model : undefined,
              );
            } else {
              if (input.changes.model !== undefined) {
                session.activeModel = input.changes.model ?? undefined;
                const modelMeta = session.models.find((m) => m.id === session.activeModel);
                if (modelMeta?.thinkingOptions) {
                  session.thinkingOptions = modelMeta.thinkingOptions;
                  session.activeThinking =
                    modelMeta.defaultThinkingOptionId ?? modelMeta.thinkingOptions[0]?.id;
                }
              }
              if (input.changes.mode !== undefined) {
                session.activeMode = input.changes.mode ?? undefined;
              }
              if (input.changes.thinkingOption !== undefined) {
                session.activeThinking = input.changes.thinkingOption ?? undefined;
              }
              // Reset backend agent handle if model/mode changed before next turn? Keep session alive
              // if possible; next backend creation will pick up new settings.
              emit({
                type: "session.config",
                sessionId: session.sessionId,
                config: buildSessionConfig(session),
              });
              emit({
                type: "session.persistence",
                sessionId: session.sessionId,
                persistence: toPersistence(session),
              });
            }
            emit({ type: "request.completed", requestId: input.requestId });
          } catch (error) {
            emit({
              type: "request.failed",
              requestId: input.requestId,
              error: { message: error instanceof Error ? error.message : String(error) },
            });
          }
          return;
        }

        case "session.prompt": {
          const session = sessions.get(input.sessionId);
          if (!session) {
            emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: { message: "Session not found" } },
            });
            return;
          }
          void handlePrompt(session, input.prompt);
          return;
        }

        case "session.permission": {
          const session = sessions.get(input.sessionId);
          const paseo = deps.getPaseo();
          const mapped = session?.permissionMap.get(input.permissionId);
          if (session && paseo && mapped) {
            session.permissionMap.delete(input.permissionId);
            await paseo.agents
              .ref(mapped.backendAgentId)
              .respondToPermission({
                requestId: mapped.requestId,
                response: input.response,
              })
              .catch((error: unknown) => {
                console.error("[provider-switch] Failed to forward permission response:", error);
              });
          }
          return;
        }

        case "session.interrupt": {
          const session = sessions.get(input.sessionId);
          if (session?.cancelActiveTurn) {
            await session.cancelActiveTurn();
          }
          emit({ type: "request.completed", requestId: input.requestId });
          return;
        }

        case "session.close": {
          const session = sessions.get(input.sessionId);
          if (session) {
            await session.cancelActiveTurn?.().catch(() => undefined);
            sessions.delete(input.sessionId);
          }
          emit({ type: "request.completed", requestId: input.requestId });
          return;
        }

        default: {
          if ("requestId" in input && typeof input.requestId === "string") {
            emit({ type: "request.completed", requestId: input.requestId });
          }
        }
      }
    },
  };
}

function formatProviderLabel(id: string): string {
  switch (id) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "antigravity":
      return "Antigravity";
    case "opencode":
      return "OpenCode";
    case "copilot":
      return "Copilot";
    default:
      return id.charAt(0).toUpperCase() + id.slice(1);
  }
}

function ensureBackendChoice(
  backends: ReadonlyArray<{ id: string; label: string }>,
  activeBackend: string,
): Array<{ id: string; label: string }> {
  if (backends.some((b) => b.id === activeBackend)) return [...backends];
  return [{ id: activeBackend, label: formatProviderLabel(activeBackend) }, ...backends];
}

function extractPromptText(prompt: ProviderPrompt): string {
  if (prompt.input.type !== "message") return "";
  const parts: string[] = [];
  for (const block of prompt.input.content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "uploaded_file") {
      parts.push(`[Attached file: ${block.fileName} (${block.path})]`);
    }
  }
  return parts.join("\n").trim();
}

function parsePersistence(persistence: ProviderPersistence | undefined): SwitchablePersistenceData | null {
  if (!persistence || persistence.version !== 1 || !persistence.data || typeof persistence.data !== "object") {
    return null;
  }
  const raw = persistence.data as Partial<SwitchablePersistenceData>;
  if (typeof raw.activeBackend !== "string" || !raw.activeBackend) return null;
  return {
    activeBackend: raw.activeBackend,
    activeModel: typeof raw.activeModel === "string" ? raw.activeModel : undefined,
    activeMode: typeof raw.activeMode === "string" ? raw.activeMode : undefined,
    activeThinking: typeof raw.activeThinking === "string" ? raw.activeThinking : undefined,
    backendAgents: raw.backendAgents && typeof raw.backendAgents === "object" ? { ...raw.backendAgents } : {},
    backendWatermarks:
      raw.backendWatermarks && typeof raw.backendWatermarks === "object" ? { ...raw.backendWatermarks } : {},
    history: Array.isArray(raw.history) ? raw.history : [],
    replayItems: Array.isArray(raw.replayItems) ? raw.replayItems : [],
    pendingHandoff: typeof raw.pendingHandoff === "string" ? raw.pendingHandoff : undefined,
  };
}

function mapBackendTimelineItem(
  item: AgentTimelineItem,
  turnId: string,
  nextId: () => string,
  idMap: Map<string, string>,
): ProviderTimelineItem | null {
  const stableId = (key: string) => {
    let id = idMap.get(key);
    if (!id) {
      id = nextId();
      idMap.set(key, id);
    }
    return id;
  };

  switch (item.type) {
    case "assistant_message":
      return {
        type: "assistant_message",
        id: stableId(item.messageId ? `msg:${item.messageId}` : `assistant:${turnId}`),
        text: item.text,
      };
    case "reasoning":
      return {
        type: "reasoning",
        id: stableId(`reasoning:${turnId}`),
        text: item.text,
      };
    case "tool_call": {
      const id = stableId(`tool:${item.callId}`);
      const detail = item.detail as ProviderToolCallDetail;
      if (item.status === "failed") {
        return {
          type: "tool_call",
          id,
          callId: item.callId,
          name: item.name,
          detail,
          status: "failed",
          error: (item.error ?? "Tool call failed") as JsonValue,
        };
      }
      return {
        type: "tool_call",
        id,
        callId: item.callId,
        name: item.name,
        detail,
        status: item.status,
        error: null,
      };
    }
    case "todo":
      return {
        type: "todo",
        id: stableId(`todo:${turnId}`),
        items: item.items,
      };
    case "error":
      return {
        type: "error",
        id: nextId(),
        message: item.message,
      };
    case "notification":
      return {
        type: "notification",
        id: nextId(),
        level: item.level,
        message: item.message,
      };
    default:
      return null;
  }
}

function mapPermissionRequest(
  req: {
    id: string;
    name: string;
    kind: "tool" | "plan" | "question" | "mode" | "other";
    title?: string;
    description?: string;
    input?: Record<string, unknown>;
    detail?: unknown;
    actions?: ProviderPermissionRequest["actions"];
  },
  mappedId: string,
): ProviderPermissionRequest {
  return {
    id: mappedId,
    name: req.name,
    kind: req.kind,
    title: req.title,
    description: req.description,
    input: req.input as Readonly<Record<string, JsonValue>> | undefined,
    detail: req.detail as ProviderToolCallDetail | undefined,
    actions: req.actions,
  };
}
