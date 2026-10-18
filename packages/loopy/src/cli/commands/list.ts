import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, expectNoArguments } from "../context.js";
import { printJson } from "../output.js";

export async function runList(context: CliContext): Promise<void> {
  expectNoArguments(context);
  printJson(
    await request(
      context,
      `/loopies?workspace=${encodeURIComponent(context.cwd)}`,
      routes.loopies.response,
    ),
  );
}
