import { command, loopy, step } from "loopy";

export default loopy({
  name: "review-sdk",
  description: "Read the working diff and record a review summary.",
  input: { "instructions?": "string" },
  run: async ({ input, log }) => {
    const diff = await command("git.diff", { program: "git", args: ["diff", "--", "."] });

    const review = await step("review", () => ({
      outcome: diff.stdout.trim() === "" ? "clean" : "changes-found",
      instructions: input.instructions ?? "Review the uncommitted changes.",
      diff: diff.stdout,
    }));

    log.info("Review summary recorded.", { outcome: review.outcome });

    return review;
  },
});
