import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, optionalTarget } from "../context.js";
import { printJson } from "../output.js";

export async function runRuns(context: CliContext): Promise<void> {
  const slug = optionalTarget(context);
  printJson(
    await request(
      context,
      `/runs${slug === undefined ? "" : `?slug=${encodeURIComponent(slug)}`}`,
      routes.runs.response,
    ),
  );
}
