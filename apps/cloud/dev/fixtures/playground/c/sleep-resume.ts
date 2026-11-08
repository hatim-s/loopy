import { code, log, loopy, sleep } from "loopy";

export default loopy("playground-c-sleep-resume", {
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  description: "Seed records, suspend for two seconds, then read them and publish a report.",
  run: ({ input }) => {
    code("seed-repository", {
      in: { input, slug: "playground-c-sleep-resume" },
      out: { kind: "record", fields: { records: "number", sourceHash: "string" } },
      module: "./modules/seed.ts",
      timeout: "10s",
      retry: { attempts: 1 },
    });

    log("report-suspended", { ordinal: input.get("ordinal"), seconds: 2 });
    sleep("2s");
    log("report-resumed", { ordinal: input.get("ordinal") });

    return code("resume-report", {
      in: { input },
      out: { kind: "record", fields: { artifactPath: "string", summary: "string" } },
      module: "./modules/resume-report.ts",
      timeout: "10s",
      retry: { attempts: 1 },
    });
  },
});
