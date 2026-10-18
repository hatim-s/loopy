import { branch, code, git, log, loopy, lte, sh, size } from "../../../src/sdk/graph/index.js";

export default loopy("review", {
  input: { "instructions?": "string" },
  run: ({ input }) => {
    const changes = git.diff.raw({}, { label: "changes" });

    return branch(lte(size(changes.get("stdout")), 0), {
      yes: () => {
        log("No uncommitted changes.");

        return { outcome: "clean", review: null };
      },
      no: () => {
        const diff = git.diff.raw({}, { label: "diff" });

        const prompt = code("prompt", {
          in: { diff: diff.get("stdout"), instructions: input.get("instructions") },
          out: { kind: "record", fields: { prompt: "string" } },
          module: "./review/prompt.ts",
        });

        const review = sh.exec(["codex", "exec", "-", "--sandbox", "read-only"], {
          label: "review",
          stdin: prompt.get("prompt"),
        });

        log("Review completed.");

        return { outcome: "reviewed", review: review.get("stdout") };
      },
    });
  },
});
