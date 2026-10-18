import { code, loopy, now, uuid } from "../../../src/sdk/graph/index.js";

export default loopy("uacode-asset-sync", {
  input: { repository: "string", base: "string", dryRun: "boolean", request: "json" },
  run: ({ input }) => {
    const base = code("prerequisites", {
      in: {
        repository: input.get("repository"),
        base: input.get("base"),
        dryRun: input.get("dryRun"),
        request: input.get("request"),
      },
      out: { kind: "record", fields: { sha: "string" } },
      module: "./asset-sync/prerequisites.ts",
    });

    const target = code("target", {
      in: { request: input.get("request"), base, id: uuid(), time: now() },
      out: { kind: "record", fields: { branch: "string", worktree: "string" } },
      module: "./asset-sync/target.ts",
    });

    const synchronized = code("synchronize", {
      in: { input, base, target },
      out: { kind: "record", fields: { summary: "json" } },
      module: "./asset-sync/synchronize.ts",
    });

    const inspected = code("inspect", {
      in: { synchronized, target },
      out: { kind: "record", fields: { files: "json" } },
      module: "./asset-sync/inspect.ts",
    });

    const published = code("publish", {
      in: { input, target, inspected },
      out: { kind: "record", fields: { prUrl: "string" } },
      module: "./asset-sync/publish.ts",
    });

    code("cleanup", {
      in: { target },
      out: { kind: "record", fields: {} },
      module: "./asset-sync/cleanup.ts",
    });

    return published;
  },
});
