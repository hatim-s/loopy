import { stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { Registry } from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";

/** A source outside the working directory belongs to its own project unless --cwd says otherwise. */
async function projectRoot(context: CliContext, source: string, isDirectory: boolean) {
  if (context.values.cwd) {
    return context.cwd;
  }
  const fromCwd = relative(context.cwd, source);
  if (fromCwd !== ".." && !fromCwd.startsWith("../")) {
    return context.cwd;
  }
  return isDirectory ? source : dirname(source);
}

export async function runSave(context: CliContext): Promise<void> {
  const source = resolve(requireTarget(context, "TypeScript file or directory"));
  const isDirectory = (await stat(source)).isDirectory();
  const registry = new Registry(context.home, await projectRoot(context, source, isDirectory));
  const options = { replace: context.values.replace };
  printJson(
    isDirectory
      ? await registry.saveDirectory(source, options)
      : await registry.saveFile(source, options),
  );
}
