import { currentBuilder } from "../builder.js";
import { type AuthorValue, type Ref, serialize, serializeValues } from "../ref.js";

export function format(
  template: string,
  values: Readonly<
    Record<
      string,
      string | number | boolean | null | Ref<string | number | boolean | null | undefined>
    >
  >,
) {
  const builder = currentBuilder();

  return builder.ref<string>(
    builder.add({ kind: "format", template, values: serializeValues(values, builder) }).id,
  );
}

export function log(message: string | Ref<string>, data?: AuthorValue) {
  const builder = currentBuilder();

  return builder.ref<null>(
    builder.add({
      kind: "log",
      message: serialize(message, builder),
      data: serialize(data, builder),
    }).id,
  );
}

export function now() {
  const builder = currentBuilder();

  return builder.ref<string>(builder.add({ kind: "now" }).id);
}

export function uuid() {
  const builder = currentBuilder();

  return builder.ref<string>(builder.add({ kind: "uuid" }).id);
}

export function random() {
  const builder = currentBuilder();

  return builder.ref<number>(builder.add({ kind: "random" }).id);
}
