import type { InputSpec, Json } from "../../core/index.js";
import type { GraphBuilder } from "./builder.js";
import type { InputRefs } from "./types.js";

export function inputRefs<S extends InputSpec>(builder: GraphBuilder, schema: S): InputRefs<S>;
export function inputRefs(builder: GraphBuilder, schema: InputSpec) {
  const input = builder.ref<Record<string, Json>>("input", schema);

  return Object.fromEntries(
    Object.keys(schema).map((field) => {
      const key = field.replace(/\?$/, "");

      return [key, input.get(key)];
    }),
  );
}
