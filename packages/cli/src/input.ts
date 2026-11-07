import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { assertJson, isFieldValue, type Json, type RecordSpec, setOwnProperty } from "@loopy/core";
import { Effect } from "effect";
import type { CliContext } from "./context";
import { CliError, cliIO, cliSync } from "./errors";

export const jsonInput = Effect.fn(function* (context: CliContext) {
  const text = context.values["input-json"];
  const file = context.values["input-file"];

  const raw =
    file === undefined
      ? (text ?? "{}")
      : yield* cliIO(() => Bun.file(resolve(context.cwd, file)).text());

  return yield* cliSync(() => {
    const value: unknown = JSON.parse(raw);
    assertJson(value, file === undefined ? "JSON input" : "Input file");

    return value;
  });
});

const coerce = Effect.fn(function* (value: string, kind: RecordSpec[string], key: string) {
  if (kind === "json" || kind.endsWith("[]")) {
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(value),
      catch: (cause) => new CliError({ message: `Input --${key} must be valid JSON.`, cause }),
    });

    if (isFieldValue(kind, parsed)) {
      return parsed;
    }
  } else if (kind === "string") {
    return value;
  } else if (kind === "number" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  } else if (kind === "boolean" && (value === "true" || value === "false")) {
    return value === "true";
  }

  return yield* new CliError({
    message: `Input --${key} must be a ${kind}. Provide a valid value.`,
  });
});

type NamedInput = Record<string, Json>;

const recordInput = (spec: RecordSpec, context: CliContext) =>
  Effect.scoped(
    Effect.gen(function* () {
      const input: NamedInput = {};
      Object.assign(input, context.namedInput);

      const prompt = yield* Effect.acquireRelease(
        Effect.sync(() =>
          process.stdin.isTTY && process.stderr.isTTY
            ? createInterface({ input: process.stdin, output: process.stderr })
            : undefined,
        ),
        (prompt) => Effect.sync(() => prompt?.close()),
      );

      for (const [field, kind] of Object.entries(spec)) {
        const key = field.replace(/\?$/, "");
        const supplied = context.namedInput?.[key];

        const value =
          supplied ??
          (!field.endsWith("?") && prompt
            ? yield* cliIO((signal) => prompt.question(`${key}: `, { signal }))
            : undefined);

        if (value !== undefined) {
          setOwnProperty(input, key, yield* coerce(value, kind, key));
        }
      }

      return input;
    }),
  );

export const graphInput = Effect.fn(function* (spec: RecordSpec | "schema", context: CliContext) {
  if (context.values["input-json"] !== undefined || context.values["input-file"] !== undefined) {
    return yield* jsonInput(context);
  }

  if (spec === "schema") {
    return yield* new CliError({ message: "Graph input requires a record schema." });
  }

  return yield* recordInput(spec, context);
});
