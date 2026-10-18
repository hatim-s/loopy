import { code, log, loopy, uuid } from "loopy";

export default loopy("www-uacode-sync", {
  input: {
    repository: "string",
    dryRun: "boolean",
    "sourceRef?": "string",
    "targetBranches?": "string",
  },
  run: ({ input }) => {
    const options = code("validate", {
      in: {
        repository: input.get("repository"),
        dryRun: input.get("dryRun"),
        sourceRef: input.get("sourceRef"),
        targetBranches: input.get("targetBranches"),
      },
      out: { options: "json" },
      module: "./www-sync/validate.ts",
    });

    const source = code("snapshot", {
      in: { options },
      out: { sha: "string", files: "json" },
      module: "./www-sync/snapshot.ts",
    });

    const plan = code("plan", {
      in: { options, source, id: uuid() },
      out: { changes: "json", target: "json" },
      module: "./www-sync/plan.ts",
    });

    const verified = code("verify", {
      in: { options, plan },
      out: { observed: "json" },
      module: "./www-sync/verify.ts",
    });

    const results = code("publish", {
      in: { options, plan, verified },
      out: { results: "json" },
      module: "./www-sync/publish.ts",
    });

    code("cleanup", {
      in: { plan },
      out: {},
      module: "./www-sync/cleanup.ts",
    });
    log("Prompt and skill synchronization completed.", { dryRun: input.get("dryRun") });

    return { sourceSha: source.get("sha"), results };
  },
});
