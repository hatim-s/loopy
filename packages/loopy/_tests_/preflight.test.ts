import { expect, test } from "bun:test";
import type { CommandNode, ConditionNode } from "../src/core/model.js";
import { validateRunInput } from "../src/runtime/preflight.js";

const missing: CommandNode = {
  id: "needs-input",
  kind: "command",
  command: { program: "tool", args: [{ $ref: { source: "input", path: ["value"] } }] },
};
const output = { $ref: { source: "steps", path: ["probe", "stdout"] } } as const;

test("only checks the selected input-dependent branch", () => {
  const condition: ConditionNode = {
    id: "choice",
    kind: "condition",
    test: { $ref: { source: "input", path: ["enabled"] } },
    // biome-ignore lint/suspicious/noThenProperty: The workflow format names its true branch `then`.
    then: [missing],
    else: [],
  };
  expect(() => validateRunInput([condition], { enabled: false })).not.toThrow();
  expect(() => validateRunInput([condition], { enabled: true })).toThrow("Missing input.value");
  expect(() => validateRunInput([condition], { enabled: "yes" })).toThrow("boolean");
});

test("defers unknown branches while checking later unconditional nodes", () => {
  const condition: ConditionNode = {
    id: "choice",
    kind: "condition",
    test: { $op: "eq", args: [output, "yes"] },
    // biome-ignore lint/suspicious/noThenProperty: The workflow format names its true branch `then`.
    then: [missing],
    else: [],
  };
  expect(() => validateRunInput([condition], {})).not.toThrow();
  expect(() => validateRunInput([condition, missing], {})).toThrow("Missing input.value");
  expect(() =>
    validateRunInput([condition], {}, new Map([["probe", { stdout: "no" }]])),
  ).not.toThrow();
  expect(() => validateRunInput([condition], {}, new Map([["probe", { stdout: "yes" }]]))).toThrow(
    "Missing input.value",
  );
});

test("checks known arguments and nested inputs beside unknown outputs", () => {
  for (const args of [
    [output, ...missing.command.args],
    [{ $op: "concat", args: [output, ...missing.command.args] }],
  ] as const) {
    expect(() =>
      validateRunInput([{ ...missing, command: { program: "tool", args: [...args] } }], {}),
    ).toThrow("Missing input.value");
  }
  expect(() =>
    validateRunInput(
      [
        {
          ...missing,
          command: {
            program: "tool",
            args: [output],
            stdin: { $ref: { source: "input", path: ["body"] } },
          },
        },
      ],
      {},
    ),
  ).toThrow("Missing input.body");
  expect(() =>
    validateRunInput(
      [
        {
          ...missing,
          command: {
            program: "tool",
            args: [output],
            env: { VALUE: { $ref: { source: "input", path: ["env"] } } },
          },
        },
      ],
      {},
    ),
  ).toThrow("Missing input.env");
});

test("keeps eager expression evaluation and typed argument constraints", () => {
  expect(() =>
    validateRunInput(
      [
        {
          id: "choice",
          kind: "condition",
          test: { $op: "and", args: [false, { $ref: { source: "input", path: ["enabled"] } }] },
          // biome-ignore lint/suspicious/noThenProperty: The workflow format names its true branch `then`.
          then: [],
          else: [],
        },
      ],
      {},
    ),
  ).toThrow("Missing input.enabled");
  expect(() =>
    validateRunInput(
      [
        {
          ...missing,
          command: {
            program: "tool",
            args: [output, { $ref: { source: "input", path: ["mode"] } }],
            argConstraints: { 1: { kind: "string", choices: ["safe"] } },
          },
        },
      ],
      { mode: "unsafe" },
    ),
  ).toThrow("must be one of safe");
});
