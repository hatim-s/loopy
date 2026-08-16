import { toJSONSchema, type ZodType } from "zod";
import { PublicPersistedSchemas } from "./schemas.js";

export type JsonSchema = Record<string, unknown>;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

/** Convert a public Zod contract using Zod 4's native JSON Schema conversion. */
export function emitJsonSchema(schema: ZodType): JsonSchema {
  return sortKeys(
    toJSONSchema(schema, {
      target: "draft-2020-12",
      unrepresentable: "throw",
      reused: "ref",
      cycles: "ref",
    }),
  ) as JsonSchema;
}

/** Generate all persisted schemas in stable key order for snapshots and tooling. */
export function emitPublicJsonSchemas(): Record<string, JsonSchema> {
  return Object.fromEntries(
    Object.keys(PublicPersistedSchemas)
      .sort()
      .map((name) => [
        name,
        emitJsonSchema(PublicPersistedSchemas[name as keyof typeof PublicPersistedSchemas]),
      ]),
  );
}
