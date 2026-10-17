import type { InputSpec } from "../../core/index.js";
import { GraphBuilder } from "./builder.js";
import { inputRefs } from "./input.js";
import type { AuthorValue } from "./ref.js";

export function loopy<const S extends InputSpec>(definition: {
  name: string;
  input: S;
  run(context: { input: ReturnType<typeof inputRefs<S>> }): AuthorValue;
}) {
  const builder = new GraphBuilder(definition.name, definition.input);

  return builder.run(() =>
    builder.finish(definition.run({ input: inputRefs(builder, definition.input) })),
  );
}
