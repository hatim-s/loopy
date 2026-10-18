import type { Duration } from "../../../core/index.js";
import { currentBuilder } from "../builder.js";
import type { Ref, RefValue, SchemaRef } from "../ref.js";
import { type Normalized, normalizeOut, type Output } from "../schema.js";

export function wait<const S extends Output>(
  label: string,
  options: { timeout?: Duration; payload: S },
): SchemaRef<Normalized<S>>;
export function wait(label: string, options?: { timeout?: Duration; payload?: never }): Ref<null>;
export function wait(
  label: string,
  options: { timeout?: Duration; payload?: Output } = {},
): RefValue {
  const builder = currentBuilder();
  const payload = normalizeOut(options.payload);

  const node = builder.add({ kind: "wait", timeout: options.timeout ?? null, payload }, label);

  return builder.schemaRef(node.id, payload);
}

export function sleep(duration: Duration): Ref<null> {
  const builder = currentBuilder();

  return builder.scalarRef<null>(builder.add({ kind: "sleep", duration }).id);
}
