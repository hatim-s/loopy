import type { Duration, OutputSchema } from "../../../core/index.js";
import { currentBuilder } from "../builder.js";
import type { InferSchema } from "../types.js";

export function wait<const S extends OutputSchema>(
  label: string,
  options: { timeout?: Duration; payload: S },
) {
  const builder = currentBuilder();

  const node = builder.add(
    { kind: "wait", timeout: options.timeout ?? null, payload: options.payload },
    label,
  );

  return builder.ref<InferSchema<S>>(node.id, options.payload);
}

export function sleep(duration: Duration) {
  const builder = currentBuilder();

  return builder.ref<null>(builder.add({ kind: "sleep", duration }).id);
}
