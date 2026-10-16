import { git, loopy } from "loopy";
import { codexExec } from "./codex.ts";

export default loopy({
  name: "review",
  description: "Ask Codex to review the uncommitted changes in a repository.",
  mode: "full",
  input: { "instructions?": "string" },
  run: async ({ input, log }) => {
    const changes = await git.diff();

    if (changes.length === 0) {
      log.info("No uncommitted changes.");

      return { outcome: "clean", review: null };
    }

    const diff = (await git.diff.raw()).stdout;

    const review = await codexExec(
      { args: ["-"], flags: { sandbox: "read-only" } },
      {
        stdin: `Review these changes without editing files.\n${diff}\n${input.instructions ?? "Report actionable findings."}`,
        timeout: "10m",
      },
    );

    log.info("Review completed.");

    return { outcome: "reviewed", review: review.stdout };
  },
});
