import {
  branch,
  code,
  defineCommand,
  eq,
  loopy,
  map,
  parallel,
  sh,
} from "../../../packages/loopy/src/sdk/graph";

const parsed = defineCommand(
  { key: "acceptance.printf", program: "printf", parse: "./parse.ts" },
  { kind: "value", type: "number" },
);

export default loopy("acceptance-values", {
  input: { choose: "boolean", items: "number[]" },
  run: ({ input }) => {
    const number = parsed({ args: ["%s", "7"] });

    const choice = branch(eq(input.get("choose"), true), {
      yes: () => "yes",
      no: () => sh(["sh", "-c", "touch forbidden-arm; printf no"]),
    });

    const values = map(
      input.get("items"),
      (item) =>
        code("double", {
          in: { item },
          out: { kind: "value", type: "number" },
          module: "./double.ts",
        }),
      { concurrency: 2, onError: "fail" },
    );

    return parallel({
      command: () => sh(["printf", "%s", "hello"]).get("stdout"),
      parsed: () => number,
      doubled: () =>
        code("parallel-double", {
          in: { item: number },
          out: { kind: "value", type: "number" },
          module: "./double.ts",
        }),
      choice: () => choice,
      values: () => values,
    });
  },
});
