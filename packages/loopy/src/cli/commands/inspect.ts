import { routes } from "../../contract/index.js";
import { call } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";

export async function runInspect(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  const snapshot = await call(context, routes.run, { params: { id }, query: {}, body: undefined });
  printJson(snapshot);
}
