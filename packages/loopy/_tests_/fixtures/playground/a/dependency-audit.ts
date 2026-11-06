import { branch, code, eq, fail, log, loopy, parallel } from "loopy/graph";

export default loopy("playground-a-dependency-audit", {
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  description: "Audit a synthetic dependency manifest with parallel local policy scans.",
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

    const scans = parallel({
      inventory: () =>
        code("inventory", {
          in: { policy: "inventory" },
          out: { kind: "record", fields: { policy: "string", count: "number" } },
          module: "./modules/dependency-scan.ts",
          timeout: "20s",
          retry: { attempts: 1 },
        }),
      review: () =>
        code("review", {
          in: { policy: "review" },
          out: { kind: "record", fields: { policy: "string", count: "number" } },
          module: "./modules/dependency-scan.ts",
          timeout: "20s",
          retry: { attempts: 1 },
        }),
    });

    log("dependency-scans-finished", scans);

    return branch(eq(input.get("fail"), true), {
      yes: () => fail("Controlled dependency policy failure requested by fixture input."),
      no: () =>
        code("audit-report", {
          in: {
            batch: input.get("batch"),
            ordinal: input.get("ordinal"),
            inventory: scans.get("inventory"),
            review: scans.get("review"),
          },
          out: { kind: "record", fields: { artifactPath: "string", files: "number" } },
          module: "./modules/dependency-report.ts",
          timeout: "20s",
          retry: { attempts: 1 },
        }),
    });
  },
});
