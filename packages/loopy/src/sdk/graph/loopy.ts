import type { GraphMeta, RecordSpec } from "../../core/index.js";
import { GraphBuilder } from "./builder.js";
import { parseDefinitionInput, parseDefinitionMeta } from "./definition.js";
import { inputRef } from "./input.js";
import type { AuthorValue, SchemaRef } from "./ref.js";

export function loopy<const S extends RecordSpec>(
  name: string,
  definition: { [K in Exclude<keyof GraphMeta, "schedule">]?: NonNullable<GraphMeta[K]> } & {
    schedule?: { cron: string; tz?: string };
  } & {
    input: S;
    run(context: { input: SchemaRef<{ kind: "record"; fields: S }> }): AuthorValue;
  },
) {
  const builder = new GraphBuilder(
    name,
    parseDefinitionInput(definition.input),
    parseDefinitionMeta(name, definition),
  );

  return builder.run(() =>
    builder.finish(definition.run({ input: inputRef(builder, definition.input) })),
  );
}
