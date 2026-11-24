import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import type { SwitchSettings } from "../shared/settings";

const NativeAbortSignal = AbortSignal as typeof AbortSignal & {
  any(signals: AbortSignal[]): AbortSignal;
  timeout(delay: number): AbortSignal;
};

export interface CompactEntry {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  provider?: string;
}

export interface CompactionResult {
  briefing: string;
  compactorUsed: string;
  durationMs: number;
  entryCount: number;
}

const COMPACT_SYSTEM_PROMPT = `You compact a coding-agent conversation for seamless provider handoff inside the same chat.
Produce a concise, high-signal technical handoff briefing in the same language the user used.
Include only concrete facts that the next AI coding agent needs to take over immediately:
1. Goal & Context
2. Completed Work & Key Files (exact paths/symbols if mentioned)
3. Decisions & Constraints
4. Current State & Open Next Steps

Be compact, factual, and direct. Do not invent details. Do not wrap in commentary.`;

const DIRECT_TIMEOUT_MS = 12_000;
const SHORT_HISTORY_THRESHOLD = 1_800;
const settingsPath = join(homedir(), ".claude", "settings.json");

type Env = Record<string, unknown>;
let settingsCache: { mtimeMs: number; env: Promise<Env> } | undefined;

async function readClaudeSettingsEnv(): Promise<Env> {
  const file = await stat(settingsPath).catch(() => null);
  if (!file) {
    settingsCache = undefined;
    return {};
  }
  if (settingsCache?.mtimeMs !== file.mtimeMs) {
    const env = readFile(settingsPath, "utf8")
      .then((text): Env => {
        const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
        if (!parsed || typeof parsed !== "object" || !("env" in parsed)) return {};
        const value = (parsed as { env?: unknown }).env;
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Env) : {};
      })
      .catch(() => ({}));
    settingsCache = { mtimeMs: file.mtimeMs, env };
  }
  return settingsCache.env;
}

function envStr(env: Env, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function resolveCompactorModel(requestedModel: string, baseUrl: URL): string {
  const trimmed = requestedModel.trim();
  const host = baseUrl.hostname;
  if (
    (trimmed === "haiku" || trimmed === "") &&
    (host === "deepseek.com" || host.endsWith(".deepseek.com"))
  ) {
    return "deepseek-chat";
  }
  return trimmed || "claude-haiku-4-5-20251001";
}

export function isThinkingModel(model: string): boolean {
  return /(?:^|[-_/])(?:reasoner|reasoning|thinking|deepseek-v4-(?:flash|pro)|deepseek-flash|deepseek-r1)(?:$|[-_/.])/i.test(
    model,
  );
}

export function extractAnthropicText(content: readonly unknown[]): string {
  let text = "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      text += block.text;
    }
  }
  return text.trim();
}

function clipText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head - 5;
  return `${trimmed.slice(0, head)} ... ${trimmed.slice(trimmed.length - tail)}`;
}

export function formatEntriesForCompaction(
  entries: readonly CompactEntry[],
  budgetChars = 16_000,
): string {
  const lines = entries
    .filter((entry) => entry.text.trim().length > 0)
    .map((entry) => {
      const label =
        entry.role === "user"
          ? "User"
          : entry.role === "assistant"
            ? entry.provider
              ? `Assistant(${entry.provider})`
              : "Assistant"
            : entry.role === "tool"
              ? "Tool"
              : "Error";
      const maxPerLine = entry.role === "tool" ? 240 : 1_600;
      return `${label}: ${clipText(entry.text, maxPerLine)}`;
    });

  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (used + line.length > budgetChars && kept.length > 0) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept.join("\n");
}

/** Split entries into earlier history (to summarize) and the newest N user turns (kept verbatim). */
export function splitRecentTurns(
  entries: readonly CompactEntry[],
  keepRecentTurns: number,
): { earlier: CompactEntry[]; recent: CompactEntry[] } {
  if (entries.length === 0 || keepRecentTurns <= 0) {
    return { earlier: [...entries], recent: [] };
  }
  let userTurnsFound = 0;
  let splitIndex = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.role === "user") {
      userTurnsFound += 1;
      if (userTurnsFound >= keepRecentTurns) {
        splitIndex = i;
        break;
      }
    }
  }
  if (userTurnsFound < keepRecentTurns) {
    return { earlier: [], recent: [...entries] };
  }
  return {
    earlier: entries.slice(0, splitIndex),
    recent: entries.slice(splitIndex),
  };
}

export function buildStructuredFallbackBriefing(
  entries: readonly CompactEntry[],
  maxChars: number,
  fromProvider?: string,
  toProvider?: string,
): string {
  const header = fromProvider && toProvider
    ? `Context handoff after switching provider from ${fromProvider} to ${toProvider}:`
    : "Compacted conversation context for seamless takeover:";
  const body = formatEntriesForCompaction(entries, Math.max(800, maxChars - header.length - 120));
  return `${header}\n\n${body}`;
}

export interface DirectCompactorConfig {
  baseUrl: URL;
  token: string;
  model: string;
}

export async function readDirectCompactorConfig(
  requestedModel: string,
): Promise<DirectCompactorConfig | null> {
  const settings = await readClaudeSettingsEnv();
  const fallback = process.env;
  const pick = (key: string) => envStr(settings, key) ?? envStr(fallback, key);
  const token =
    envStr(settings, "ANTHROPIC_AUTH_TOKEN") ??
    envStr(settings, "ANTHROPIC_API_KEY") ??
    envStr(fallback, "ANTHROPIC_AUTH_TOKEN") ??
    envStr(fallback, "ANTHROPIC_API_KEY");
  const endpoint = pick("ANTHROPIC_BASE_URL");
  if (!token || !endpoint || !URL.canParse(endpoint)) return null;
  const baseUrl = new URL(endpoint);
  if (
    (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    return null;
  }
  return {
    baseUrl,
    token,
    model: resolveCompactorModel(requestedModel, baseUrl),
  };
}

export async function requestDirectCompaction(
  config: DirectCompactorConfig,
  transcript: string,
  signal?: AbortSignal,
  timeoutMs = DIRECT_TIMEOUT_MS,
): Promise<string> {
  const timeoutSignal = NativeAbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? NativeAbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${config.baseUrl.href.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": config.token,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: isThinkingModel(config.model) ? 2048 : 1024,
      temperature: 0.1,
      system: COMPACT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Conversation history to compact:\n\n${transcript}\n\nProduce the structured handoff briefing:`,
        },
      ],
    }),
    redirect: "error",
    signal: requestSignal as unknown as RequestInit["signal"],
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`Compactor API returned HTTP ${response.status}`);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || !("content" in payload) || !Array.isArray(payload.content)) {
    throw new Error("Compactor API returned invalid content");
  }
  const text = extractAnthropicText(payload.content);
  if (!text) throw new Error("Compactor API returned empty summary");
  return text;
}

export interface CompactOptions {
  fromProvider?: string;
  toProvider?: string;
  signal?: AbortSignal;
  requestDirect?: typeof requestDirectCompaction;
  readConfig?: typeof readDirectCompactorConfig;
}

export async function compactHistory(
  entries: readonly CompactEntry[],
  settings: SwitchSettings,
  options: CompactOptions = {},
): Promise<CompactionResult> {
  const startedAt = performance.now();
  const elapsed = () => Math.max(1, Math.round(performance.now() - startedAt));
  const nonEmpty = entries.filter((entry) => entry.text.trim().length > 0);
  if (nonEmpty.length === 0) {
    return {
      briefing: "",
      compactorUsed: "empty",
      durationMs: elapsed(),
      entryCount: 0,
    };
  }

  const fullFormatted = formatEntriesForCompaction(nonEmpty, settings.maxCompactedChars);
  if (fullFormatted.length <= SHORT_HISTORY_THRESHOLD || settings.compactorTransport === "fallback") {
    return {
      briefing: buildStructuredFallbackBriefing(
        nonEmpty,
        settings.maxCompactedChars,
        options.fromProvider,
        options.toProvider,
      ),
      compactorUsed: fullFormatted.length <= SHORT_HISTORY_THRESHOLD ? "verbatim" : "structured-fallback",
      durationMs: elapsed(),
      entryCount: nonEmpty.length,
    };
  }

  const { earlier, recent } = splitRecentTurns(nonEmpty, settings.keepRecentTurns);
  const toSummarize = earlier.length > 0 ? earlier : nonEmpty;
  const transcript = formatEntriesForCompaction(toSummarize, 18_000);

  const readConfig = options.readConfig ?? readDirectCompactorConfig;
  const runDirect = options.requestDirect ?? requestDirectCompaction;

  try {
    const config = await readConfig(settings.compactorModel);
    if (!config) {
      throw new Error("Direct compactor API not configured");
    }
    const summary = await runDirect(config, transcript, options.signal);
    const recentBlock =
      earlier.length > 0 && recent.length > 0
        ? `\n\n## Most Recent Turns (Verbatim)\n${formatEntriesForCompaction(
            recent,
            Math.max(1_000, Math.floor(settings.maxCompactedChars * 0.45)),
          )}`
        : "";
    const header = options.fromProvider && options.toProvider
      ? `## Compacted Context (${options.fromProvider} -> ${options.toProvider})\n`
      : "## Compacted Context\n";
    const combined = `${header}${summary}${recentBlock}`.slice(0, settings.maxCompactedChars);
    return {
      briefing: combined,
      compactorUsed: `direct:${config.model}`,
      durationMs: elapsed(),
      entryCount: nonEmpty.length,
    };
  } catch (error) {
    console.warn(
      `[provider-switch] Direct compaction fallback: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      briefing: buildStructuredFallbackBriefing(
        nonEmpty,
        settings.maxCompactedChars,
        options.fromProvider,
        options.toProvider,
      ),
      compactorUsed: "structured-fallback",
      durationMs: elapsed(),
      entryCount: nonEmpty.length,
    };
  }
}

export function wrapHandoffPrompt(briefing: string, userMessage?: string): string {
  const trimmedBriefing = briefing.trim();
  const trimmedUser = userMessage?.trim() ?? "";
  if (!trimmedBriefing) return trimmedUser;
  if (!trimmedUser) {
    return [
      "<provider_switch_handoff>",
      trimmedBriefing,
      "</provider_switch_handoff>",
      "",
      "You have taken over this conversation after a provider switch. Briefly confirm you have the compacted context and are ready to continue (or continue any clearly pending step).",
    ].join("\n");
  }
  return [
    "<provider_switch_handoff>",
    trimmedBriefing,
    "</provider_switch_handoff>",
    "",
    "Continue the conversation seamlessly using the compacted handoff context above. Respond directly to the user's latest message below:",
    "",
    trimmedUser,
  ].join("\n");
}
