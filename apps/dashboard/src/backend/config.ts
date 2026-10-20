import { z } from "zod";

export const backendConfigSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("http"), workspace: z.undefined().optional() }),
  z.strictObject({ mode: z.literal("fake"), workspace: z.undefined().optional() }),
  z.strictObject({
    mode: z.literal("legacy"),
    workspace: z
      .string({ error: "Set VITE_LEGACY_WORKSPACE to the legacy daemon's run directory." })
      .trim()
      .min(1, "VITE_LEGACY_WORKSPACE must name the legacy daemon's run directory."),
  }),
]);
