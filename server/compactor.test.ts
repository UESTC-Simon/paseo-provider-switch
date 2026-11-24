import { describe, expect, it } from "vitest";
import { switchSettings } from "../shared/settings";
import {
  compactHistory,
  extractAnthropicText,
  formatEntriesForCompaction,
  isThinkingModel,
  resolveCompactorModel,
  splitRecentTurns,
  wrapHandoffPrompt,
} from "./compactor";

const defaultSettings = switchSettings.schema.parse({});

describe("compactor", () => {
  it("maps haiku on deepseek.com to deepseek-chat", () => {
    expect(resolveCompactorModel("haiku", new URL("https://api.deepseek.com/anthropic"))).toBe(
      "deepseek-chat",
    );
    expect(resolveCompactorModel("deepseek-chat", new URL("https://api.deepseek.com/anthropic"))).toBe(
      "deepseek-chat",
    );
  });

  it("detects thinking models accurately", () => {
    expect(isThinkingModel("deepseek-v4-flash")).toBe(true);
    expect(isThinkingModel("deepseek-reasoner")).toBe(true);
    expect(isThinkingModel("deepseek-chat")).toBe(false);
  });

  it("extracts only text blocks from mixed thinking and text payloads", () => {
    expect(
      extractAnthropicText([
        { type: "thinking", thinking: "internal reasoning" },
        { type: "text", text: "Goal: fix auth." },
      ]),
    ).toBe("Goal: fix auth.");
  });

  it("splits recent turns verbatim while compacting earlier turns", () => {
    const entries = [
      { role: "user" as const, text: "Turn 1" },
      { role: "assistant" as const, text: "Reply 1" },
      { role: "user" as const, text: "Turn 2" },
      { role: "assistant" as const, text: "Reply 2" },
      { role: "user" as const, text: "Turn 3" },
      { role: "assistant" as const, text: "Reply 3" },
    ];
    const { earlier, recent } = splitRecentTurns(entries, 2);
    expect(earlier).toHaveLength(2);
    expect(recent).toHaveLength(4);
    expect(recent[0]?.text).toBe("Turn 2");
  });

  it("uses verbatim fast path for short history without external calls", async () => {
    const result = await compactHistory(
      [
        { role: "user", text: "Add a login button" },
        { role: "assistant", text: "Added LoginButton in src/login.tsx", provider: "claude" },
      ],
      defaultSettings,
      { fromProvider: "claude", toProvider: "codex" },
    );
    expect(result.compactorUsed).toBe("verbatim");
    expect(result.briefing).toContain("claude to codex");
    expect(result.briefing).toContain("src/login.tsx");
  });

  it("calls direct compactor on long history and preserves recent turns", async () => {
    const longHistory = Array.from({ length: 10 }, (_, idx) => [
      { role: "user" as const, text: `Step ${idx}: ${"detail ".repeat(45)}` },
      { role: "assistant" as const, text: `Done ${idx}: ${"result ".repeat(45)}`, provider: "antigravity" },
    ]).flat();

    const result = await compactHistory(longHistory, defaultSettings, {
      fromProvider: "antigravity",
      toProvider: "codex",
      readConfig: async () => ({
        baseUrl: new URL("https://api.deepseek.com/anthropic"),
        token: "test-token",
        model: "deepseek-chat",
      }),
      requestDirect: async () => "Goal: multi-step migration\nCompleted: steps 0-6",
    });

    expect(result.compactorUsed).toBe("direct:deepseek-chat");
    expect(result.briefing).toContain("Goal: multi-step migration");
    expect(result.briefing).toContain("Most Recent Turns (Verbatim)");
    expect(result.briefing).toContain("Step 9");
  });

  it("falls back cleanly when direct API fails", async () => {
    const longHistory = Array.from({ length: 8 }, (_, idx) => [
      { role: "user" as const, text: `Task ${idx}: ${"x".repeat(300)}` },
      { role: "assistant" as const, text: `Answer ${idx}: ${"y".repeat(300)}` },
    ]).flat();

    const result = await compactHistory(longHistory, defaultSettings, {
      fromProvider: "claude",
      toProvider: "codex",
      readConfig: async () => ({
        baseUrl: new URL("https://api.deepseek.com/anthropic"),
        token: "test-token",
        model: "deepseek-chat",
      }),
      requestDirect: async () => {
        throw new Error("Network timeout");
      },
    });

    expect(result.compactorUsed).toBe("structured-fallback");
    expect(result.briefing).toContain("Task 7");
  });

  it("wraps handoff prompt cleanly", () => {
    const wrapped = wrapHandoffPrompt("Summary here", "Now write tests");
    expect(wrapped).toContain("<provider_switch_handoff>");
    expect(wrapped).toContain("Summary here");
    expect(wrapped).toContain("Now write tests");
    expect(formatEntriesForCompaction([{ role: "tool", text: "shell: npm test" }])).toContain("Tool:");
  });
});
