import type { RecordSpec } from "../../core/index.js";
import { GraphBuilder } from "./builder.js";
import { inputRef } from "./input.js";
import type { AuthorValue } from "./ref.js";

export function loopy<const S extends RecordSpec>(definition: {
  name: string;
  input: S;
  run(context: { input: ReturnType<typeof inputRef<S>> }): AuthorValue;
}) {
  const builder = new GraphBuilder(definition.name, definition.input);

  return builder.run(() =>
    builder.finish(definition.run({ input: inputRef(builder, definition.input) })),
  );
}
