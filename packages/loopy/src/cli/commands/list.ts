import { routes } from "../../contract/index.js";
import { call } from "../client.js";
import { type CliContext, expectNoArguments } from "../context.js";
import { printJson } from "../output.js";

export async function runList(context: CliContext): Promise<void> {
  expectNoArguments(context);
  printJson(
    await call(context, routes.loopies, {
      params: {},
      query: { workspace: context.cwd },
      body: undefined,
    }),
  );
}
