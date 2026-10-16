import { git, loopy } from "loopy";
import { codexExec } from "./codex.ts";

export default loopy({
  name: "review",
  description: "Ask Codex to review the uncommitted changes in a repository.",
  mode: "full",
  input: { "instructions?": "string" },
  run: async ({ input, log }) => {
    const diff = await git.diff.raw({ flags: { stat: true } });

    if (diff.stdout.trim() === "") {
      log.info("No uncommitted changes.");

      return { outcome: "clean", review: null };
    }

    const review = await codexExec(
      { args: ["-"], flags: { sandbox: "read-only", json: true } },
      {
        stdin: `Review these changes without editing files.\n${diff.stdout}\n${input.instructions ?? "Report actionable findings."}`,
        timeout: "10m",
      },
    );

    log.info("Review completed.");

    return { outcome: "reviewed", review: review.stdout };
  },
});
