import { branch, code, eq, fail, log, loopy, map, sleep } from "../../../../src/sdk/graph";

export default loopy("playground-a-generated-docs", {
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  description:
    "Read repository source exports, generate documentation sections and publish an index.",
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

    const sections = map(
      input.get("items"),
      (item, index) =>
        code("document-export", {
          in: { item, index },
          out: { kind: "value", type: "string" },
          module: "./modules/docs-section.ts",
          timeout: "20s",
          retry: { attempts: 1 },
        }),
      { concurrency: 2, onError: "fail" },
    );

    sleep(200);
    log("documentation-sections-ready", { ordinal: input.get("ordinal") });

    return branch(eq(input.get("fail"), true), {
      yes: () => fail("Controlled generated documentation failure requested by fixture input."),
      no: () =>
        code("publish-docs", {
          in: { batch: input.get("batch"), ordinal: input.get("ordinal"), sections },
          out: { kind: "record", fields: { artifactPath: "string", files: "number" } },
          module: "./modules/docs-publish.ts",
          timeout: "20s",
          retry: { attempts: 1 },
        }),
    });
  },
});
