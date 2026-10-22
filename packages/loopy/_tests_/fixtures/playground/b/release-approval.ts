import { code, log, loopy, wait } from "loopy/graph";

export default loopy("playground-b-release-approval", {
  description: "Hold a synthetic release for approval, then write its release report",
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

    const approval = wait("approval", {
      timeout: "5m",
      payload: { kind: "record", fields: { approved: "boolean" } },
    });

    log("release-approval-resolved", approval);

    return code("release", {
      in: {
        batch: input.get("batch"),
        ordinal: input.get("ordinal"),
        fail: input.get("fail"),
        items: input.get("items"),
        approved: approval.get("approved"),
      },
      out: {
        kind: "record",
        fields: { artifactPath: "string", checksum: "number", entries: "number" },
      },
      module: "./modules/release.ts",
      retry: { attempts: 1 },
      timeout: "10s",
    });
  },
});
