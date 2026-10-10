import { expect, test } from "bun:test";
import { workflowInputs } from "../src/cli/input-fields.ts";
import { collectInputs } from "../src/cli/prompt.ts";
import { at, concat, eq, gt, node, trigger } from "../src/core/index.ts";

/** For prompts whose validation messages are not under test. */
const ignoreWarning = () => undefined;

function nextAnswer(answers: string[]): string {
  const answer = answers.shift();

  if (answer === undefined) {
    throw new Error("The prompt asked beyond the scripted answers.");
  }

  return answer;
}

test("branch choices and types preserve each valid alternative", async () => {
  const graph = trigger<{ count: number | string; color: string }>("alternatives")
    .condition(
      "branch",
      ({ input }) => eq(input.count, "none"),
      ({ input }) =>
        node("red", {
          program: "echo",
          args: [input.color],
          argConstraints: { 0: { kind: "string", choices: ["red"] } },
        }),
      ({ input }) =>
        node("blue", {
          program: "echo",
          args: [input.color, input.count],
          argConstraints: { 0: { kind: "string", choices: ["blue"] }, 1: { kind: "number" } },
        }),
    )
    .build();

  expect(
    workflowInputs(graph).map((field) => ({ kind: field.kind, choices: field.choices })),
  ).toEqual([
    { kind: undefined, choices: undefined },
    { kind: "string", choices: ["red", "blue"] },
  ]);
  const answers = ["json:2", "blue"];
  expect(await collectInputs(graph, {}, async () => nextAnswer(answers), ignoreWarning)).toEqual({
    count: 2,
    color: "blue",
  });
  const other = ["none", "red"];
  expect(await collectInputs(graph, {}, async () => nextAnswer(other), ignoreWarning)).toEqual({
    count: "none",
    color: "red",
  });
});

test("a parent JSON answer supplies nested references without overwriting them", async () => {
  const graph = trigger<{ data: { name: string } }>("parent")
    .condition(
      "branch",
      ({ input }) => ({ $op: "eq", args: [input.data, null] }),
      node("empty", { program: "true", args: [] }),
      ({ input }) =>
        node("name", {
          program: "echo",
          args: [at(input.data, "name")],
        }),
    )
    .build();

  let asks = 0;
  expect(
    await collectInputs(
      graph,
      {},
      async () => {
        asks++;

        return 'json:{"name":"Ada"}';
      },
      ignoreWarning,
    ),
  ).toEqual({ data: { name: "Ada" } });
  expect(asks).toBe(1);
});

const workflow = trigger<{
  message: string;
  count: number;
  enabled: boolean;
  data: { name: string };
}>("prompt-test")
  .node("first", ({ input }) => ({
    program: "echo",
    args: [input.message, input.count],
    argConstraints: { 1: { kind: "number" } },
  }))
  .condition(
    "branch",
    ({ input }) => input.enabled,
    ({ input }) => node("yes", { program: "echo", args: [input.message, at(input.data, "name")] }),
    ({ input }) => node("no", { program: "echo", args: [concat("count=", input.count)] }),
  )
  .build();

test("discovers deduplicated input paths across commands and branches with inferred types", () => {
  expect(workflowInputs(workflow)).toEqual([
    { path: ["message"], kind: undefined, choices: undefined },
    { path: ["count"], kind: "number", choices: undefined },
    { path: ["enabled"], kind: "boolean", choices: undefined },
    { path: ["data", "name"], kind: undefined, choices: undefined },
  ]);
});

test("collects missing fields, retries invalid values, and preserves supplied input", async () => {
  const answers = ["oops", "3", "yes", "false", "Ada"];
  const labels: string[] = [];
  const errors: string[] = [];
  const supplied = { message: "hello" };
  expect(
    await collectInputs(
      workflow,
      supplied,
      async (label) => {
        labels.push(label);

        return nextAnswer(answers);
      },
      (message) => errors.push(message),
    ),
  ).toEqual({ message: "hello", count: 3, enabled: false, data: { name: "Ada" } });
  expect(supplied).toEqual({ message: "hello" });
  expect(labels).toHaveLength(5);
  expect(errors).toEqual(["Enter a finite number.", "Enter true or false."]);
});

test("validates attached choices and expression numbers", async () => {
  const graph = trigger<{ color: string; size: number }>("typed")
    .node("color", ({ input }) => ({
      program: "echo",
      args: [concat("--color=", input.color)],
      argConstraints: { 0: { kind: "string", prefix: "--color=", choices: ["red", "blue"] } },
    }))
    .condition(
      "large",
      ({ input }) => gt(input.size, 2),
      node("big", { program: "true", args: [] }),
      node("small", { program: "true", args: [] }),
    )
    .build();

  const answers = ["green", "red", "4"];
  const errors: string[] = [];
  expect(
    await collectInputs(
      graph,
      {},
      async () => nextAnswer(answers),
      (message) => errors.push(message),
    ),
  ).toEqual({ color: "red", size: 4 });
  expect(errors).toEqual(["Choose one of: red, blue."]);
});

test("text, JSON, and prototype-named inputs stay safe", async () => {
  const graph = trigger<{
    __proto__: string;
    constructor: { name: string };
    value: string;
    empty: string;
  }>("special")
    .node("echo", ({ input }) => ({
      program: "echo",
      args: [input.__proto__, at(input.constructor, "name"), input.value, input.empty],
    }))
    .build();

  const answers = ["safe", "json:[1,2]", "text:json:literal", ""];

  const input = await collectInputs(graph, {}, async () => nextAnswer(answers), ignoreWarning);

  expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
  expect(Object.hasOwn(input, "__proto__")).toBe(true);
  expect(input).toEqual(
    JSON.parse(
      '{"__proto__":"safe","constructor":{"name":[1,2]},"value":"json:literal","empty":""}',
    ),
  );
  expect(input.value).toBe("json:literal");
  expect(input.empty).toBe("");
});

test("cancellation rejects collection and graphs without inputs never ask", async () => {
  await expect(
    collectInputs(
      workflow,
      {},
      async () => {
        throw new Error("cancelled");
      },
      ignoreWarning,
    ),
  ).rejects.toThrow("cancelled");
  const graph = trigger("no-input").node("noop", { program: "true", args: [] }).build();
  expect(
    await collectInputs(
      graph,
      {},
      async () => {
        throw new Error("unexpected prompt");
      },
      ignoreWarning,
    ),
  ).toEqual({});
});
