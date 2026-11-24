import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { SWITCHABLE_PROVIDER_ID, type SwitchSettings } from "../shared/settings";
import { type CompactEntry, compactHistory, wrapHandoffPrompt } from "./compactor";

export function timelineItemsToCompactEntries(
  items: readonly AgentTimelineItem[],
  provider?: string,
): CompactEntry[] {
  const entries: CompactEntry[] = [];
  for (const item of items) {
    switch (item.type) {
      case "user_message":
        if (item.text.trim()) entries.push({ role: "user", text: item.text });
        break;
      case "assistant_message": {
        if (!item.text.trim()) break;
        const prev = entries.at(-1);
        if (prev?.role === "assistant" && prev.provider === provider) {
          prev.text += `\n${item.text}`;
        } else {
          entries.push({ role: "assistant", text: item.text, provider });
        }
        break;
      }
      case "tool_call": {
        const summary = summarizeToolDetail(item.name, item.status, item.detail);
        entries.push({ role: "tool", text: summary });
        break;
      }
      case "error":
        if (item.message.trim()) entries.push({ role: "error", text: item.message });
        break;
      default:
        break;
    }
  }
  return entries;
}

function summarizeToolDetail(
  name: string,
  status: string,
  detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"],
): string {
  switch (detail.type) {
    case "shell":
      return `${name} (${status}): $ ${detail.command}`;
    case "read":
      return `${name} (${status}): read ${detail.filePath}`;
    case "edit":
      return `${name} (${status}): edit ${detail.filePath}`;
    case "write":
      return `${name} (${status}): write ${detail.filePath}`;
    case "search":
      return `${name} (${status}): search "${detail.query}"`;
    case "fetch":
      return `${name} (${status}): fetch ${detail.url}`;
    default:
      return `${name} (${status})`;
  }
}

export interface HandoffRequest {
  sourceAgentId: string;
  targetProvider: string;
  targetModel?: string;
  targetModeId?: string;
  archiveSource?: boolean;
}

export interface HandoffResult {
  newAgentId: string;
  workspaceId: string | null;
  targetProvider: string;
  compactedChars: number;
  compactorUsed: string;
  durationMs: number;
}

export async function performNativeHandoff(
  paseo: PaseoApi,
  request: HandoffRequest,
  settings: SwitchSettings,
): Promise<HandoffResult> {
  const sourceRef = paseo.agents.ref(request.sourceAgentId);
  const refreshed = await sourceRef.refresh();
  if (!refreshed) {
    throw new Error(`Source agent ${request.sourceAgentId} was not found.`);
  }
  const sourceAgent = refreshed.agent;
  if (sourceAgent.status === "running") {
    throw new Error("Wait for the current turn to finish before switching providers.");
  }

  const page = await sourceRef.timeline.refetch({ direction: "tail", limit: 120 });
  const entries = timelineItemsToCompactEntries(
    page.entries.map((entry) => entry.item),
    sourceAgent.provider,
  );

  const compacted = await compactHistory(entries, settings, {
    fromProvider: sourceAgent.provider,
    toProvider: request.targetProvider,
  });

  const targetProviderSpec = request.targetModel
    ? `${request.targetProvider}/${request.targetModel}`
    : request.targetProvider;

  const baseTitle = sourceAgent.title?.replace(/^\[Switched[^\]]*\]\s*/i, "").trim();
  const title = baseTitle
    ? `[Switched → ${request.targetProvider}] ${baseTitle}`
    : `Switched → ${request.targetProvider}`;

  const prompt = wrapHandoffPrompt(compacted.briefing);
  const providerOptions =
    request.targetProvider === SWITCHABLE_PROVIDER_ID
      ? { backend: settings.defaultBackendProvider }
      : undefined;

  const createConfig = {
    provider: targetProviderSpec,
    modeId: request.targetModeId || undefined,
    options: providerOptions,
  };

  const created = sourceAgent.workspaceId
    ? await paseo.workspaces.ref(sourceAgent.workspaceId).agents.create({
        config: createConfig,
        title,
        prompt: prompt || undefined,
      })
    : await paseo.agents.create({
        config: createConfig,
        cwd: sourceAgent.cwd,
        title,
        prompt: prompt || undefined,
      });

  const shouldArchive = request.archiveSource ?? settings.archiveSourceOnHandoff;
  if (shouldArchive) {
    await sourceRef.archive().catch((error: unknown) => {
      console.error("[provider-switch] Failed to archive source agent:", error);
    });
  }

  return {
    newAgentId: created.id,
    workspaceId: sourceAgent.workspaceId ?? null,
    targetProvider: request.targetProvider,
    compactedChars: compacted.briefing.length,
    compactorUsed: compacted.compactorUsed,
    durationMs: compacted.durationMs,
  };
}
