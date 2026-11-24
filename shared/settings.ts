import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SWITCHABLE_PROVIDER_ID = "switchable";
export const BACKEND_LABEL_KEY = "provider-switch/backend";
export const BACKEND_LABEL_VALUE = "true";
export const AGENT_TEAM_ROLE_LABEL_KEY = "agent-team/role";
export const AGENT_TEAM_ROLE_WORKER = "worker";

export const switchSettings = defineSettings({
  id: "provider-switch",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Initial backend provider when starting a new Switchable chat. */
    defaultBackendProvider: z.string().trim().min(1).default("antigravity"),
    /** Compaction engine: auto tries fast direct HTTP API then structured local fallback. */
    compactorTransport: z.enum(["auto", "direct", "fallback"]).default("auto"),
    /** Model used for direct HTTP compaction (defaults to fast non-thinking deepseek-chat). */
    compactorModel: z.string().trim().min(1).default("deepseek-chat"),
    /** Maximum character budget for the compacted handoff briefing. */
    maxCompactedChars: z.number().int().min(1200).max(24000).default(8000),
    /** Number of newest turns kept verbatim alongside the compacted earlier summary. */
    keepRecentTurns: z.number().int().min(1).max(10).default(3),
    /** For native chat handoff: archive the old chat after creating the new one. */
    archiveSourceOnHandoff: z.boolean().default(false),
  }),
});

export type SwitchSettings = z.output<typeof switchSettings.schema>;
