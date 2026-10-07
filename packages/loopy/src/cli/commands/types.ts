import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateCommand } from "../../local/index.js";
import { type CliContext, requireArgument } from "../context.js";
import { printJson, report } from "../output.js";

export async function runTypes(context: CliContext): Promise<void> {
  const [binary, ...path] = context.positionals;
  const destination = resolve(requireArgument(context.values.out, "--out"));
  const generated = await generateCommand(requireArgument(binary, "CLI executable"), path, {
    name: context.values.name,
  });
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, generated.source);
  for (const warning of generated.warnings) {
    report(warning);
  }
  printJson({ file: destination });
}
