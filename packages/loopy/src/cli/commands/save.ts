import { dirname, relative, resolve } from "node:path";
import { bundleLoopy, Loopies, loadLoopy } from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";

export async function runSave(context: CliContext): Promise<void> {
  const source = resolve(context.cwd, requireTarget(context, "TypeScript file"));

  const bundle = await bundleLoopy(source, context.home);
  const loopy = await loadLoopy(bundle.path);

  const path = relative(context.cwd, source);
  const outside = path === ".." || path.startsWith("../");
  const cwd = !context.values.cwd && outside ? dirname(source) : context.cwd;
  printJson(
    new Loopies(context.home, cwd).save(loopy, {
      source,
      bundleHash: bundle.hash,
      replace: context.values.replace,
    }),
  );
}
