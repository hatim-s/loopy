import { code, log, loopy } from "loopy";

export default loopy("playground-b-retry-marker", {
  description: "A safe marker makes attempt one fail and attempt two update CI values",
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
    log("retry-marker-ready");

    return code("retry-update", {
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
      module: "./modules/retry-marker.ts",
      retry: { attempts: 2, retryOnExit: true },
      timeout: "10s",
    });
  },
});
