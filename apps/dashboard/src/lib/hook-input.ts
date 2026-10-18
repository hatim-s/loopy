import type { Json } from "loopy/contract";
import { z } from "zod";

/** The step-shaped dashboard fixture remains until the waits UI arrives in PR 5. */
const hookInputSchema = z.strictObject({ name: z.string(), token: z.string() });

export type HookInput = z.infer<typeof hookInputSchema>;

/** Step input is stored JSON whose shape depends on the step kind, so a hook step parses it. */
export function hookInput(input: Json): HookInput | null {
  const parsed = hookInputSchema.safeParse(input);

  return parsed.success ? parsed.data : null;
}
