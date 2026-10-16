import { type CliContext, optionalTarget } from "../context.js";
import { printJson } from "../output.js";
import { withRunStore } from "../store.js";

export async function runRuns(context: CliContext): Promise<void> {
  const slug = optionalTarget(context);
  printJson(await withRunStore(context.home, (store) => store.listRuns({ slug })));
}
