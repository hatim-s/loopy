import { code, log, loopy, wait } from "../../../../src/sdk/graph";

export default loopy("playground-c-security-review", {
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  description: "Seed repository policy and source, hold security approval, then publish a review.",
  run: ({ input }) => {
    code("seed-repository", {
      in: { input, slug: "playground-c-security-review" },
      out: { kind: "record", fields: { records: "number", sourceHash: "string" } },
      module: "./modules/seed.ts",
      timeout: "10s",
      retry: { attempts: 1 },
    });

    log("awaiting-approval", { batch: input.get("batch"), ordinal: input.get("ordinal") });

    const approval = wait("approval", {
      payload: { kind: "record", fields: { approved: "boolean" } },
      timeout: "5m",
    });

    log("approval-resolved", { ordinal: input.get("ordinal"), approved: approval.get("approved") });

    return code("publish-report", {
      in: { input, approved: approval.get("approved") },
      out: { kind: "record", fields: { artifactPath: "string", summary: "string" } },
      module: "./modules/security.ts",
      timeout: "10s",
      retry: { attempts: 1 },
    });
  },
});
