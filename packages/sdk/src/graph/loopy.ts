import {
  type GraphMeta,
  type InputValidation,
  parseInputValidation,
  type RecordSpec,
} from "@loopy/core";
import { GraphBuilder } from "./builder";
import { parseDefinitionInput, parseDefinitionMeta } from "./definition";
import { inputRef } from "./input";
import type { AuthorValue } from "./ref";

export type LoopyDefinition<S extends RecordSpec> = {
  [K in Exclude<keyof GraphMeta, "schedule">]?: NonNullable<GraphMeta[K]>;
} & {
  schedule?: { cron: string; tz?: string };
  input: S;
  inputValidation?: InputValidation;
  run(context: { input: ReturnType<typeof inputRef<S>> }): AuthorValue;
};

export function loopy<const S extends RecordSpec>(name: string, definition: LoopyDefinition<S>) {
  const builder = new GraphBuilder(
    name,
    parseDefinitionInput(definition.input),
    parseDefinitionMeta(name, definition),
    parseInputValidation(definition.inputValidation, definition.input),
  );

  return builder.run(() =>
    builder.finish(definition.run({ input: inputRef(builder, definition.input) })),
  );
}
