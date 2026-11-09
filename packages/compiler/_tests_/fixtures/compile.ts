import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { qualityTestRoot } from "../../../runtime/_tests_/fixtures/quality-test-root";
import { compile as compileEffect } from "../../src";

/** Writes an author entry, plus a module whose default export is not a function. */
export async function project(source: string) {
  const root = qualityTestRoot("compile-test");
  const file = join(root, "entry.ts");
  await writeFile(file, source);
  await writeFile(join(root, "not-function.ts"), "export default 1;");

  return { root, file };
}

export function compile(path: string) {
  return Effect.runPromise(compileEffect(path));
}

/** Compiles an author file a test wrote, failing the test with the diagnostics when it is invalid. */
export async function compileOrThrow(file: string) {
  const result = await compile(file);

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  return result;
}
