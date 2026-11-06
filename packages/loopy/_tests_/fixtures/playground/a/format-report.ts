import { branch, code, eq, fail, log, loopy } from "../../../../src/sdk/graph";

export default loopy("playground-a-format-report", {
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  description: "Seed repository sources, normalize whitespace and export a format report.",
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
    log("format-start", { batch: input.get("batch"), ordinal: input.get("ordinal") });

    return branch(eq(input.get("fail"), true), {
      yes: () => fail("Controlled format check failure requested by fixture input."),
      no: () =>
        code("format", {
          in: {
            batch: input.get("batch"),
            ordinal: input.get("ordinal"),
            fail: input.get("fail"),
            items: input.get("items"),
          },
          out: { kind: "record", fields: { artifactPath: "string", files: "number" } },
          module: "./modules/format.ts",
          timeout: "20s",
          retry: { attempts: 1 },
        }),
    });
  },
});
