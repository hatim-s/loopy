import { routes } from "../../contract/index.js";
import { call } from "../client.js";
import { type CliContext, optionalTarget } from "../context.js";
import { printJson } from "../output.js";

export async function runRuns(context: CliContext): Promise<void> {
  const slug = optionalTarget(context);
  printJson(await call(context, routes.runs, { params: {}, query: { slug }, body: undefined }));
}
