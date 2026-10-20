import { z } from "zod";

export const backendConfigSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("http"), workspace: z.undefined().optional() }),
  z.strictObject({ mode: z.literal("fake"), workspace: z.undefined().optional() }),
]);
