import { isRecord, requireOneOf, requireRecord, setOwnProperty } from "../core/index.js";

import type * as StandardSchemaV1 from "./schema-types.js";

type StandardSchemaV1<Input = unknown, Output = Input> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    // BOUNDARY: Standard Schema validators receive external input before it has a type.
    validate(
      value: unknown,
    ): StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
};

export type { StandardSchemaV1 };

export type RecordSpec = Readonly<Record<string, "string" | "number" | "boolean">>;

export type InputSchema = StandardSchemaV1 | RecordSpec;

type Primitive = { string: string; number: number; boolean: boolean };

type RecordInput<Spec extends RecordSpec> = {
  -readonly [Key in keyof Spec as Key extends `${string}?` ? never : Key]: Primitive[Spec[Key]];
} & {
  -readonly [Key in keyof Spec as Key extends `${infer Name}?`
    ? Name
    : never]?: Primitive[Spec[Key]];
};

export type inferInput<Def> = Def extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<Def>
  : Def extends RecordSpec
    ? RecordInput<Def>
    : Def extends { input: infer Schema }
      ? inferInput<Schema>
      : Record<string, never>;

// BOUNDARY: Imported schemas are untyped module values until their Standard Schema contract is checked.
export function isStandardSchema<Value>(value: Value): value is Value & StandardSchemaV1 {
  if (!isRecord(value) || !isRecord(value["~standard"])) {
    return false;
  }

  const standard = value["~standard"];

  return (
    standard.version === 1 &&
    typeof standard.vendor === "string" &&
    typeof standard.validate === "function"
  );
}

// BOUNDARY: Record schema input comes from argv or external JSON and must match each declared primitive.
function validateRecord(spec: RecordSpec, value: unknown): StandardSchemaV1.Result<unknown> {
  if (!isRecord(value)) {
    return { issues: [{ message: "Expected an object", path: [] }] };
  }

  const issues: StandardSchemaV1.Issue[] = [];
  const output: Record<string, string | number | boolean> = {};

  for (const [field, kind] of Object.entries(spec)) {
    const optional = field.endsWith("?");
    const key = optional ? field.slice(0, -1) : field;
    const item = Object.hasOwn(value, key) ? value[key] : undefined;

    if (optional && item === undefined) {
      continue;
    }

    if (typeof item !== kind || (typeof item === "number" && !Number.isFinite(item))) {
      issues.push({ message: `Expected ${kind}`, path: [key] });
      continue;
    }

    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      setOwnProperty(output, key, item);
    }
  }

  return issues.length > 0 ? { issues } : { value: output };
}

export function recordSchema<const Spec extends RecordSpec>(
  spec: Spec,
): StandardSchemaV1<unknown, RecordInput<Spec>> {
  const fields = Object.freeze({ ...spec });

  for (const kind of Object.values(fields)) {
    requireOneOf(kind, ["string", "number", "boolean"], "Input field type");
  }

  return {
    "~standard": {
      version: 1,
      vendor: "loopy",
      validate(value) {
        const result = validateRecord(fields, value);

        if (result.issues) {
          return result;
        }

        // SAFETY: The record validator checked every field before returning this untyped schema value.
        return { value: result.value as RecordInput<Spec> };
      },
    },
  };
}

function issueMessage(issue: StandardSchemaV1.Issue): string {
  const path = issue.path?.map((part) => String(isRecord(part) ? part.key : part)).join(".");

  return `${path || "input"}: ${issue.message.replace(/\.$/, "")}`;
}

// BOUNDARY: A loopy's input is external data; its schema owns validation and the resulting type.
export function inputValidator<Schema extends InputSchema | undefined>(schema: Schema | undefined) {
  if (schema !== undefined) {
    requireRecord(schema, "Input schema");
  }

  const validator = isStandardSchema(schema) ? schema : recordSchema(schema ?? {});

  // BOUNDARY: Run input is external data validated by the author's schema.
  async function validateInput(value: unknown): Promise<inferInput<Schema>> {
    const supplied = schema === undefined && value === undefined ? {} : value;
    const result = await validator["~standard"].validate(supplied);

    if (result.issues) {
      throw new Error(
        `Input validation failed: ${result.issues.map(issueMessage).join("; ")}. Correct the input and try again.`,
      );
    }

    // SAFETY: Standard Schema validates the untyped value and guarantees the schema's inferred output.
    return result.value as inferInput<Schema>;
  }

  return validateInput;
}
