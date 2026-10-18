import type { Duration, OutSchema } from "../../../core/index.js";
import { currentBuilder } from "../builder.js";
import type { Ref } from "../ref.js";

export function wait<const S extends OutSchema>(
  label: string,
  options: { timeout?: Duration; payload: S },
) {
  const builder = currentBuilder();

  const node = builder.add(
    { kind: "wait", timeout: options.timeout ?? null, payload: options.payload },
    label,
  );

  return builder.schemaRef(node.id, options.payload);
}

export function sleep(duration: Duration): Ref<null> {
  const builder = currentBuilder();

  return builder.scalarRef<null>(builder.add({ kind: "sleep", duration }).id);
}
