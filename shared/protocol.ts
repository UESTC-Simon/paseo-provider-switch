import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const handoffAgentRpc = defineRpc({
  name: "provider-switch.handoff",
  input: z.object({
    sourceAgentId: z.string().min(1),
    targetProvider: z.string().min(1),
    targetModel: z.string().optional(),
    targetModeId: z.string().optional(),
    archiveSource: z.boolean().optional(),
  }),
  output: z.object({
    newAgentId: z.string(),
    workspaceId: z.string().nullable(),
    targetProvider: z.string(),
    compactedChars: z.number(),
    compactorUsed: z.string(),
    durationMs: z.number(),
  }),
});

export const listSwitchTargetsRpc = defineRpc({
  name: "provider-switch.targets",
  input: z.object({}),
  output: z.object({
    providers: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
      }),
    ),
  }),
});
