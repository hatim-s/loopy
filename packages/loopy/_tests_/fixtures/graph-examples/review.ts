import { branch, code, eq, git, log, loopy, sh, size } from "../../../src/sdk/graph/index.js";

export default loopy({
  name: "review",
  input: { "instructions?": "string" },
  run: ({ input }) => {
    const changes = git.diff("changes", {});

    return branch(eq(size(changes), 0), {
      yes: () => {
        log("No uncommitted changes.");

        return { outcome: "clean", review: null };
      },
      no: () => {
        const diff = git.diff.raw("diff");

        const prompt = code("prompt", {
          in: { diff: diff.get("stdout"), instructions: input.instructions },
          out: { prompt: "string" },
          module: "./review/prompt.ts",
        });

        const review = sh.exec("review", ["codex", "exec", "-", "--sandbox", "read-only"], {
          stdin: prompt.get("prompt"),
        });

        log("Review completed.");

        return { outcome: "reviewed", review: review.get("stdout") };
      },
    });
  },
});
