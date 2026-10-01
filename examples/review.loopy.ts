import { command, concat, ne, node, trigger } from "loopy";
import { codexExec } from "./codex.ts";

export default trigger<{ instructions: string }>("review")
  .description("Ask Codex to review the uncommitted changes in a repository.")
  .node("changes", command("git", "diff", "--stat"))
  .condition(
    "has-changes",
    ({ steps }) => ne(steps.changes.stdout, ""),
    ({ input, steps }) =>
      node(
        "review",
        codexExec({
          args: [
            concat(
              "Review these changes without editing files.\n",
              steps.changes.stdout,
              "\n",
              input.instructions,
            ),
          ],
          flags: { sandbox: "read-only", json: true },
        }),
      ),
    node("clean", command("printf", "%s", "No uncommitted changes.")),
  );
