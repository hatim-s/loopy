import { type CliContext, requireTarget } from "../context.js";
import { withLocalRuntime } from "../local-runtime.js";
import { executeRun } from "../run-execution.js";

export async function runResume(context: CliContext): Promise<void> {
  const { values } = context;
  if (values.full || values.input || values.cwd) {
    throw new Error("A resumed run keeps its original mode, input, and workspace.");
  }
  const id = requireTarget(context, "Run ID");
  await withLocalRuntime(context.home, ({ runtime }) =>
    executeRun(runtime, id, values["retry-uncertain"]),
  );
}
