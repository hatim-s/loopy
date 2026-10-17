import type { Json } from "loopy/contract";
import { z } from "zod";

/** What runtime/hook.ts stores as a hook step's input. The timeout is kept only as wakeAt. */
const hookInputSchema = z.strictObject({ name: z.string(), token: z.string() });

export type HookInput = z.infer<typeof hookInputSchema>;

/** Step input is stored JSON whose shape depends on the step kind, so a hook step parses it. */
export function hookInput(input: Json): HookInput | null {
  const parsed = hookInputSchema.safeParse(input);

  return parsed.success ? parsed.data : null;
}
