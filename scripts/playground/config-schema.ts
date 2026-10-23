import { z } from "zod";
import type { playgroundProfile } from "./profile.js";

export function playgroundConfigSchema(profile: ReturnType<typeof playgroundProfile>) {
  const baseConfigSchema = z.strictObject({
    batch: z.string(),
    api: z.literal(profile.api),
    dashboard: z.literal(profile.dashboard),
    workspace: z.literal("playground"),
    token: z.string().min(32),
    otherToken: z.string().min(32),
    sandboxToken: z.string().min(32),
    receiptMode: z.literal("filesystem").default("filesystem"),
    apiConcurrency: z.literal(4),
    runtimeConcurrency: z.literal(4),
    createdAt: z.string(),
  });

  const architectureConfigSchema = baseConfigSchema
    .extend({
      receiptsToken: z.string().min(32),
      receiptMode: z.literal("durable-object"),
    })
    .superRefine((value, context) => {
      if (
        new Set([value.token, value.otherToken, value.sandboxToken, value.receiptsToken]).size !== 4
      ) {
        context.addIssue({
          code: "custom",
          message: "Receipt, sandbox and user credentials must be distinct.",
        });
      }
    });

  return profile.name ? architectureConfigSchema : baseConfigSchema;
}
