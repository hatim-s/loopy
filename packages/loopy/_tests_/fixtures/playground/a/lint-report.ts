import { branch, code, eq, fail, log, loopy, map } from "../../../../src/sdk/graph";

export default loopy("playground-a-lint-report", {
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  description:
    "Read TypeScript sources and map deterministic lint checks into a repository report.",
  run: ({ input }) => {
    code("seed", {
      in: {
        batch: input.get("batch"),
        ordinal: input.get("ordinal"),
        fail: input.get("fail"),
        items: input.get("items"),
      },
      out: { kind: "record", fields: { sourceBytes: "number" } },
      module: "./modules/seed.ts",
      timeout: "20s",
      retry: { attempts: 1 },
    });

    const checks = map(
      input.get("items"),
      (item, index) =>
        code("lint-source", {
          in: { item, index },
          out: { kind: "record", fields: { check: "number", findings: "number" } },
          module: "./modules/lint.ts",
          timeout: "20s",
          retry: { attempts: 1 },
        }),
      { concurrency: 2, onError: "fail" },
    );

    log("lint-checks-finished", checks);

    return branch(eq(input.get("fail"), true), {
      yes: () => fail("Controlled lint gate failure requested by fixture input."),
      no: () =>
        code("lint-report", {
          in: { batch: input.get("batch"), ordinal: input.get("ordinal"), checks },
          out: { kind: "record", fields: { artifactPath: "string", files: "number" } },
          module: "./modules/lint-report.ts",
          timeout: "20s",
          retry: { attempts: 1 },
        }),
    });
  },
});
