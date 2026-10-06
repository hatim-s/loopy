import { expect, test } from "bun:test";
import { collectInputs, workflowInputs } from "../src/cli/inputs.ts";
import { at, concat, gt, node, trigger } from "../src/core/workflow.ts";

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
        return answers.shift() as string;
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
      async () => answers.shift() as string,
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
  const input = await collectInputs(
    graph,
    {},
    async () => answers.shift() as string,
    () => {},
  );
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
      () => {},
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
      () => {},
    ),
  ).toEqual({});
});
