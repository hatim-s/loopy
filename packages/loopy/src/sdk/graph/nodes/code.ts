import type { Duration, GraphRetry, OutputSchema } from "../../../core/index.js";
import { currentBuilder } from "../builder.js";
import { type AuthorValue, serializeValues } from "../ref.js";
import type { InferSchema } from "../types.js";

export function code<const S extends OutputSchema>(
  label: string,
  options: {
    in: Readonly<Record<string, AuthorValue>>;
    out: S;
    module: string;
    retry?: Partial<GraphRetry>;
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
      retry: builder.retry(options.retry),
      timeout: options.timeout ?? null,
    },
    label,
  );

  return builder.ref<InferSchema<S>>(node.id, options.out);
}
