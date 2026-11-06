import { branch, code, eq, fail, log, loopy, wait } from "loopy/graph";

export default loopy("playground-a-changelog-approval", {
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  description: "Draft a changelog, hold for approval and publish a repository changelog artifact.",
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
    code("draft-changelog", {
      in: {
        batch: input.get("batch"),
        ordinal: input.get("ordinal"),
        fail: input.get("fail"),
        items: input.get("items"),
      },
      out: { kind: "record", fields: { entries: "number" } },
      module: "./modules/changelog-draft.ts",
      timeout: "20s",
      retry: { attempts: 1 },
    });

    const approval = wait("approval", {
      payload: { kind: "record", fields: { approved: "boolean" } },
      timeout: "5m",
    });

    log("changelog-approval-resolved", approval);

    return branch(eq(approval.get("approved"), true), {
      yes: () =>
        branch(eq(input.get("fail"), true), {
          yes: () =>
            fail("Controlled changelog failure after approval requested by fixture input."),
          no: () =>
            code("publish-changelog", {
              in: { batch: input.get("batch"), ordinal: input.get("ordinal") },
              out: { kind: "record", fields: { artifactPath: "string", files: "number" } },
              module: "./modules/changelog-publish.ts",
              timeout: "20s",
              retry: { attempts: 1 },
            }),
        }),
      no: () => fail("Changelog approval was declined."),
    });
  },
});
