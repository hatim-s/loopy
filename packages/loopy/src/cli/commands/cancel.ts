import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";

export async function runCancel(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  printJson(
    await request(context, `/runs/${encodeURIComponent(id)}/cancel`, routes.cancelRun.response, {
      method: "POST",
    }),
  );
}
