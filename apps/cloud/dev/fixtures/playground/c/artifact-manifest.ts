import { code, log, loopy, wait } from "loopy";

export default loopy("playground-c-artifact-manifest", {
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  description:
    "Hash four repository files, hold publication approval, then verify and publish the manifest.",
  run: ({ input }) => {
    code("seed-repository", {
      in: { input, slug: "playground-c-artifact-manifest" },
      out: { kind: "record", fields: { records: "number", sourceHash: "string" } },
      module: "./modules/seed.ts",
      timeout: "10s",
      retry: { attempts: 1 },
    });

    const manifest = code("prepare-manifest", {
      in: {},
      out: { kind: "record", fields: { files: "number", manifestHash: "string" } },
      module: "./modules/manifest-plan.ts",
      timeout: "10s",
      retry: { attempts: 1 },
    });

    log("manifest-awaiting-approval", { ordinal: input.get("ordinal"), manifest });

    const approval = wait("approval", {
      payload: { kind: "record", fields: { approved: "boolean" } },
      timeout: "5m",
    });

    log("approval-resolved", { ordinal: input.get("ordinal"), approved: approval.get("approved") });

    return code("publish-manifest", {
      in: { input, approved: approval.get("approved"), expectedHash: manifest.get("manifestHash") },
      out: { kind: "record", fields: { artifactPath: "string", summary: "string" } },
      module: "./modules/manifest-publish.ts",
      timeout: "10s",
      retry: { attempts: 1 },
    });
  },
});
