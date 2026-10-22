import {
  branch,
  code,
  defineCommand,
  eq,
  log,
  loopy,
  map,
  parallel,
  sh,
} from "../../../src/sdk/graph/index.js";

const printf = defineCommand({
  namespace: "fixture",
  name: "printf",
  program: "/usr/bin/printf",
  positionals: [{ name: "value" }],
});

export default loopy("cloud-journey-execution", {
  input: { name: "string", chooseYes: "boolean", items: "number[]" },
  run: ({ input }) => {
    const selected = branch(eq(input.get("chooseYes"), true), {
      yes: () => {
        log("branch-yes");

        return "yes";
      },
      no: () => {
        log("branch-no");

        return "no";
      },
    });

    const mapped = map(
      input.get("items"),
      (item, index) =>
        code("double", {
          in: { item, index },
          out: { kind: "record", fields: { doubled: "number", index: "number" } },
          module: "./double.ts",
          retry: { attempts: 1 },
        }),
      { concurrency: 2, onError: "fail" },
    );

    const paired = parallel({
      descriptor: () => printf({ args: [input.get("name")] }, { label: "descriptor" }),
      bundle: () =>
        code("greeting", {
          in: { name: input.get("name") },
          out: { kind: "record", fields: { greeting: "string", uid: "number" } },
          module: "./greeting.ts",
          retry: { attempts: 1 },
        }),
    });

    const retried = sh.exec(
      [
        "/bin/sh",
        "-c",
        "if [ -f firstfail ]; then printf retry-ok; else printf firstfail > firstfail; exit 7; fi",
      ],
      { label: "firstfail", retry: { attempts: 2, retryOnExit: true } },
    );

    log("journey-finished", { selected, mapped });

    return { selected, mapped, paired, retried };
  },
});
