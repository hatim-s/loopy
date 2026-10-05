import { expect, test } from "bun:test";
import type { AttemptRecord, Workflow } from "../src/core/model.js";
import { decideNext } from "../src/runtime/transitions.js";

const workflow: Workflow = {
  version: 1,
  slug: "transitions",
  nodes: [{ id: "a", kind: "command", command: { program: "echo", args: [] } }],
};
const options = { resume: false, retryUncertain: false };
const attempt: AttemptRecord = {
  id: "attempt",
  runId: "run",
  nodeId: "a",
  number: 1,
  status: "running",
  input: {},
  startedAt: "2026-10-05T00:00:00Z",
};

test("a running command reconciles the original attempt instead of launching again", () => {
  expect(decideNext(workflow, {}, [attempt], options)).toEqual({ kind: "reconcile", attempt });
});
test("uncertain effects require explicit retry and success skips execution", () => {
  expect(decideNext(workflow, {}, [{ ...attempt, status: "uncertain" }], options).kind).toBe(
    "blocked",
  );
  expect(decideNext(workflow, {}, [{ ...attempt, status: "succeeded" }], options)).toEqual({
    kind: "done",
  });
});
test("recorded branches survive restart and unselected missing input stays deferred", () => {
  const branch: Workflow = {
    version: 1,
    slug: "branch",
    nodes: [
      {
        id: "choice",
        kind: "condition",
        test: true,
        // biome-ignore lint/suspicious/noThenProperty: Workflow branch field.
        then: workflow.nodes,
        else: [
          {
            id: "b",
            kind: "command",
            command: { program: "echo", args: [{ $ref: { source: "input", path: ["missing"] } }] },
          },
        ],
      },
    ],
  };
  expect(
    decideNext(
      branch,
      {},
      [{ ...attempt, nodeId: "choice", status: "succeeded", output: { branch: "then" } }],
      options,
    ).kind,
  ).toBe("command");
});
