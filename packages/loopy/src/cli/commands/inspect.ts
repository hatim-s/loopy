import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";

export async function runInspect(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  const snapshot = await request(context, `/runs/${encodeURIComponent(id)}`, routes.run.response);
  printJson(snapshot);
}
