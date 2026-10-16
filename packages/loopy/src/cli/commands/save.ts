import { stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { bundleLoopy, importLoopy, Loopies } from "../../local/index.js";
import { isLoopy } from "../../sdk/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";
import { runSave as legacySave } from "./legacy-save.js";

export async function runSave(context: CliContext): Promise<void> {
  const source = resolve(context.cwd, requireTarget(context, "TypeScript file or directory"));

  if ((await stat(source)).isDirectory()) {
    return legacySave(context);
  }

  const bundle = await bundleLoopy(source, context.home);
  const loopy = await importLoopy(bundle.path);

  if (!isLoopy(loopy)) {
    return legacySave(context);
  }

  const path = relative(context.cwd, source);
  const outside = path === ".." || path.startsWith("../");
  const cwd = !context.values.cwd && outside ? dirname(source) : context.cwd;
  printJson(
    new Loopies(context.home, cwd).save(loopy, source, bundle.hash, context.values.replace),
  );
}
