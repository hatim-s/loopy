import {
  type GraphMeta,
  type InputValidation,
  parseInputValidation,
  type RecordSpec,
} from "../../core";
import { GraphBuilder } from "./builder";
import { parseDefinitionInput, parseDefinitionMeta } from "./definition";
import { inputRef } from "./input";
import type { AuthorValue } from "./ref";

export function loopy<const S extends RecordSpec>(
  name: string,
  definition: { [K in keyof GraphMeta]?: NonNullable<GraphMeta[K]> } & {
    input: S;
    inputValidation?: InputValidation;
    run(context: { input: ReturnType<typeof inputRef<S>> }): AuthorValue;
  },
) {
  const builder = new GraphBuilder(
    name,
    parseDefinitionInput(definition.input),
    parseDefinitionMeta(name, definition),
  );

  builder.inputValidation = parseInputValidation(definition.inputValidation, definition.input);

  return builder.run(() =>
    builder.finish(definition.run({ input: inputRef(builder, definition.input) })),
  );
}
