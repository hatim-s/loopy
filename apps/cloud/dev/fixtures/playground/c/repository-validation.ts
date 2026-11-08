import { code, log, loopy, parallel } from "loopy";

export default loopy("playground-c-repository-validation", {
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  description: "Seed a repository, validate three files concurrently, then check record integrity.",
  run: ({ input }) => {
    code("seed-repository", {
      in: { input, slug: "playground-c-repository-validation" },
      out: { kind: "record", fields: { records: "number", sourceHash: "string" } },
      module: "./modules/seed.ts",
      timeout: "10s",
      retry: { attempts: 1 },
    });

    const checked = parallel({
      readme: () =>
        code("validate-readme", {
          in: { file: "README.md" },
          out: { kind: "record", fields: { file: "string", bytes: "number", hash: "string" } },
          module: "./modules/validate-file.ts",
          timeout: "10s",
          retry: { attempts: 1 },
        }),
      policy: () =>
        code("validate-policy", {
          in: { file: "docs/policy.md" },
          out: { kind: "record", fields: { file: "string", bytes: "number", hash: "string" } },
          module: "./modules/validate-file.ts",
          timeout: "10s",
          retry: { attempts: 1 },
        }),
      source: () =>
        code("validate-source", {
          in: { file: "src/limits.ts" },
          out: { kind: "record", fields: { file: "string", bytes: "number", hash: "string" } },
          module: "./modules/validate-file.ts",
          timeout: "10s",
          retry: { attempts: 1 },
        }),
    });

    log("repository-files-validated", { ordinal: input.get("ordinal"), checked });

    return code("repository-report", {
      in: { input, checked: [checked.get("readme"), checked.get("policy"), checked.get("source")] },
      out: { kind: "record", fields: { artifactPath: "string", summary: "string" } },
      module: "./modules/validation-report.ts",
      timeout: "10s",
      retry: { attempts: 1 },
    });
  },
});
