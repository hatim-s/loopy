import { Registry } from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";

export async function runGraph(context: CliContext): Promise<void> {
  const slug = requireTarget(context, "Slug");
  printJson(new Registry(context.home, context.cwd).get(slug).workflow);
}
