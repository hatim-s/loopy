import { type CliContext, requireTarget } from "../context.js";
import { withLocalRuntime } from "../local-runtime.js";
import { printJson } from "../output.js";

export async function runRecover(context: CliContext): Promise<void> {
  if (!context.values.force) {
    throw new Error(
      "Recovery requires --force. Stop the original host's runner first; it may still be executing a command.",
    );
  }
  const id = requireTarget(context, "Run ID");
  printJson(await withLocalRuntime(context.home, async (local) => local.recoverOwner(id)));
}
