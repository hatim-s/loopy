import type { Duration, GraphRetry, OutSchema, RateLimit } from "@loopy/core";
import { currentBuilder } from "../builder";
import { type AuthorValue, serializeValues } from "../ref";
import type { Infer, SchemaFields } from "../types";

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
