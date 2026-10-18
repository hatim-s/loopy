import type { Duration, GraphRetry, OutSchema, RateLimit } from "../../../core/index.js";
import { currentBuilder } from "../builder.js";
import { type AuthorValue, serializeValues } from "../ref.js";
import type { Infer, SchemaFields } from "../types.js";

export function code<const S extends OutSchema>(
  label: string,
  options: {
    in: Readonly<Record<string, AuthorValue>>;
    out: S;
    module: string;
    retry?: Partial<GraphRetry>;
    rateLimit?: RateLimit;
    timeout?: Duration;
  },
) {
  const builder = currentBuilder();

  const node = builder.add(
    {
      kind: "code",
      in: serializeValues(options.in, builder),
      out: options.out,
      module: { path: options.module, bundleHash: null },
      rateLimit: options.rateLimit ?? null,
      retry: builder.retry(options.retry),
      timeout: options.timeout ?? null,
    },
    label,
  );

  return builder.ref<Infer<S>, SchemaFields<S>>(node.id, options.out);
}
