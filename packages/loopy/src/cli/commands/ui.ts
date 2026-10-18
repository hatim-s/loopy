import { daemonUrl } from "../../local/index.js";
import { ensureDaemon } from "../client.js";
import { type CliContext, expectNoArguments } from "../context.js";
import { printLine } from "../output.js";

export async function runUi(context: CliContext): Promise<void> {
  expectNoArguments(context);
  const record = await ensureDaemon({ ...context, port: context.values.port });
  const url = new URL(daemonUrl(record));
  url.searchParams.set("workspace", context.cwd);
  printLine(url.toString());
}
