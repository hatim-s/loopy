import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";

export async function runResume(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  printJson(
    await request(context, `/runs/${encodeURIComponent(id)}/resume`, routes.resumeRun.response, {
      method: "POST",
    }),
  );
}
