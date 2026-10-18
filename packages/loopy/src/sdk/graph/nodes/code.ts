import type { Duration, GraphRetry, RateLimit } from "../../../core/index.js";
import { currentBuilder } from "../builder.js";
import type { Ref, RefValue, SchemaRef } from "../ref.js";
import { type AuthorValue, serializeValues } from "../ref.js";
import { type Normalized, normalizeOut, type Output } from "../schema.js";

type Options = {
  in: Readonly<Record<string, AuthorValue>>;
  module: string;
  retry?: Partial<GraphRetry>;
  rateLimit?: RateLimit;
  timeout?: Duration;
};

export function code<const S extends Output>(
  label: string,
  options: Options & { out: S },
): SchemaRef<Normalized<S>>;
export function code(label: string, options: Options & { out?: never }): Ref<null>;
export function code(label: string, options: Options & { out?: Output }): RefValue {
  const builder = currentBuilder();
  const out = normalizeOut(options.out);

  const node = builder.add(
    {
      kind: "code",
      in: serializeValues(options.in, builder),
      out,
      module: { path: options.module, bundleHash: null },
      rateLimit: options.rateLimit ?? null,
      retry: builder.retry(options.retry),
      timeout: options.timeout ?? null,
    },
    label,
  );

  return builder.schemaRef(node.id, out);
}
