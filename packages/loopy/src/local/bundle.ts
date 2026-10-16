import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compileWorkflow, type Workflow } from "../core/index.js";
import { isLoopy, type Loopy } from "../sdk/index.js";
import { defaultHome } from "./home.js";

export async function bundleLoopy(file: string, home = defaultHome()) {
  const result = await Bun.build({ entrypoints: [file], target: "bun", format: "esm" });
  const output = result.outputs[0];

  if (!result.success || !output) {
    throw new Error(
      `Could not bundle '${file}'. Fix the build errors and save again: ${result.logs.join("; ")}.`,
    );
  }

  const bytes = await output.arrayBuffer();
  const hash = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  const path = join(home, "bundles", `${hash}.js`);
  await mkdir(join(home, "bundles"), { recursive: true, mode: 0o700 });
  await writeFile(path, new Uint8Array(bytes), { mode: 0o600 });

  return { hash, path };
}

export async function importLoopy(path: string): Promise<Loopy | Workflow> {
  const module: { default?: unknown } = await import(pathToFileURL(path).href);

  return isLoopy(module.default) ? module.default : compileWorkflow(module.default);
}

export async function loadLoopy(path: string): Promise<Loopy> {
  const value = await importLoopy(path);

  if (!isLoopy(value)) {
    throw new Error(
      `'${path}' does not default-export a loopy() definition. Save a file with a default loopy() export.`,
    );
  }

  return value;
}
