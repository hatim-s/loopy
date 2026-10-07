import { Registry } from "../../local/index.js";
import { type CliContext, expectNoArguments } from "../context.js";
import { printJson } from "../output.js";

export async function runList(context: CliContext): Promise<void> {
  expectNoArguments(context);
  printJson(new Registry(context.home, context.cwd).list());
}
