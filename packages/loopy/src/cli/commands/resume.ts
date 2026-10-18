import { routes } from "../../contract/index.js";
import { call } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";

export async function runResume(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  printJson(await call(context, routes.resumeRun, { params: { id }, query: {}, body: undefined }));
}
