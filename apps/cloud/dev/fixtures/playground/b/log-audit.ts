import { code, log, loopy } from "loopy/graph";

export default loopy("playground-b-log-audit", {
  description: "Read seeded CI values and retain a bounded stream of audit evidence",
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
    log("ci-audit-started", { ordinal: input.get("ordinal") });

    return code("audit", {
      in: {
        batch: input.get("batch"),
        ordinal: input.get("ordinal"),
        fail: input.get("fail"),
        items: input.get("items"),
      },
      out: {
        kind: "record",
        fields: { artifactPath: "string", checksum: "number", entries: "number" },
      },
      module: "./modules/audit.ts",
      retry: { attempts: 1 },
      timeout: "10s",
    });
  },
});
