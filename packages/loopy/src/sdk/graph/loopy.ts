import type { GraphMeta, RecordSpec } from "../../core/index.js";
import { GraphBuilder } from "./builder.js";
import { inputRef } from "./input.js";
import type { AuthorValue } from "./ref.js";

export function loopy<const S extends RecordSpec>(
  name: string,
  definition: { [K in keyof GraphMeta]?: NonNullable<GraphMeta[K]> } & {
    input: S;
    run(context: { input: ReturnType<typeof inputRef<S>> }): AuthorValue;
  },
) {
  const builder = new GraphBuilder(name, definition.input, {
    description: definition.description ?? null,
    schedule: definition.schedule ?? null,
    secrets: definition.secrets ?? [],
    mode: definition.mode ?? "sandbox",
    scope: definition.scope ?? "project",
  });

  return builder.run(() =>
    builder.finish(definition.run({ input: inputRef(builder, definition.input) })),
  );
}
