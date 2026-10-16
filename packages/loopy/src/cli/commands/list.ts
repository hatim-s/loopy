import { Loopies, Registry } from "../../local/index.js";
import { type CliContext, expectNoArguments } from "../context.js";
import { printJson } from "../output.js";

export async function runList(context: CliContext): Promise<void> {
  expectNoArguments(context);

  const entries = new Map(
    new Registry(context.home, context.cwd).list().map((entry) => [entry.slug, entry]),
  );

  const sdk = new Loopies(context.home, context.cwd).list();

  const legacy = [...entries.values()].filter(
    (entry) => !sdk.some((item) => item.slug === entry.slug),
  );

  printJson([...legacy, ...sdk].sort((a, b) => a.slug.localeCompare(b.slug)));
}
