import { listLegacyRuns } from "../../local/index.js";
import { type CliContext, optionalTarget } from "../context.js";
import { withEngineStore } from "../engine-store.js";
import { printJson } from "../output.js";

export async function runRuns(context: CliContext): Promise<void> {
  const slug = optionalTarget(context);
  const runs = await withEngineStore(context.home, (store) => store.listRuns({ slug }));
  printJson([...runs, ...(await listLegacyRuns(context.home, slug))]);
}
