import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  assertJson,
  type Json,
  parseFieldText,
  type RecordSpec,
  recordFields,
  setOwnProperty,
} from "@loopy/core";
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

function coerce(text: string, kind: RecordSpec[string], key: string) {
  const parsed = parseFieldText(kind, text);

  if (parsed.ok) {
    return Effect.succeed(parsed.value);
  }

  return Effect.fail(
    new CliError({
      message:
        parsed.reason === "json"
          ? `Input --${key} must be valid JSON.`
          : `Input --${key} must be a ${kind}. Provide a valid value.`,
    }),
  );
}

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

      for (const { key, optional, kind } of recordFields(spec)) {
        const supplied = context.namedInput?.[key];

        const value =
          supplied ??
          (!optional && prompt
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
