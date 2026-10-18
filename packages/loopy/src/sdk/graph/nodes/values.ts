import { currentBuilder } from "../builder.js";
import { type AuthorValue, type Ref, serialize } from "../ref.js";

export function format(
  template: string,
  values: Readonly<
    Record<string, string | number | boolean | Ref<string | number | boolean | undefined>>
  >,
): Ref<string> {
  const builder = currentBuilder();

  return builder.scalarRef<string>(
    builder.add({
      kind: "format",
      template,
      values: serialize(values, builder),
    }).id,
  );
}

export function log(message: string | Ref<string>, data?: AuthorValue): Ref<null> {
  const builder = currentBuilder();

  return builder.scalarRef<null>(
    builder.add({
      kind: "log",
      message: serialize(message, builder),
      data: serialize(data, builder),
    }).id,
  );
}

export function now(): Ref<string> {
  const builder = currentBuilder();

  return builder.scalarRef<string>(builder.add({ kind: "now" }).id);
}

export function uuid(): Ref<string> {
  const builder = currentBuilder();

  return builder.scalarRef<string>(builder.add({ kind: "uuid" }).id);
}

export function random(): Ref<number> {
  const builder = currentBuilder();

  return builder.scalarRef<number>(builder.add({ kind: "random" }).id);
}
