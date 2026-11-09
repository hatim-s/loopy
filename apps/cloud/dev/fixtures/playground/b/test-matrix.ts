import { branch, code, eq, fail, log, loopy, map } from "loopy";

export default loopy("playground-b-test-matrix", {
  description: "Seed CI sources, map bounded test shards, and publish their scores",
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  run: ({ input }) => {
    code("seed", {
      in: {
        batch: input.get("batch"),
        ordinal: input.get("ordinal"),
        fail: input.get("fail"),
        items: input.get("items"),
      },
      out: { kind: "record", fields: { count: "number" } },
      module: "./modules/seed.ts",
      retry: { attempts: 1 },
      timeout: "10s",
    });

    const rows = map(
      input.get("items"),
      (item, index) =>
        code("shard", {
          in: { item, index },
          out: { kind: "record", fields: { score: "number" } },
          module: "./modules/matrix-shard.ts",
          retry: { attempts: 1 },
          timeout: "10s",
        }),
      { concurrency: 2, onError: "fail" },
    );

    branch(eq(input.get("fail"), true), {
      yes: () => fail("Controlled test matrix policy failure"),
      no: () => log("test-matrix-passed"),
    });

    return code("report", {
      in: {
        batch: input.get("batch"),
        ordinal: input.get("ordinal"),
        fail: input.get("fail"),
        items: input.get("items"),
        rows,
      },
      out: {
        kind: "record",
        fields: { artifactPath: "string", checksum: "number", entries: "number" },
      },
      module: "./modules/matrix-report.ts",
      retry: { attempts: 1 },
      timeout: "10s",
    });
  },
});
