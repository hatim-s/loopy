import { code, log, loopy, wait } from "loopy";

export default loopy("playground-c-data-migration", {
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  description: "Seed CSV records, hold migration approval, then write migrated data and a receipt.",
  run: ({ input }) => {
    code("seed-repository", {
      in: { input, slug: "playground-c-data-migration" },
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
      module: "./modules/migrate.ts",
      timeout: "10s",
      retry: { attempts: 1 },
    });
  },
});
