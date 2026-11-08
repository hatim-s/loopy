import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveBody } from "../../../runtime/_tests_/fixtures/project";
import { qualityTestRoot } from "../../../runtime/_tests_/fixtures/quality-test-root";
import { compileOrThrow } from "./compile";

/** A project directory holding one author definition file and its Loopy home. */
export function fixture(name: string, definition: string) {
  const root = qualityTestRoot("project");
  const file = join(root, `${name}.loopy.ts`);
  writeFileSync(
    file,
    `import { loopy, log, sh, code, sleep, wait } from "loopy";
export default loopy(${JSON.stringify(name)}, { input: {}, ${definition} });`,
  );

  return { cwd: root, home: join(root, "home"), file };
}

/** Compiles the fixture's author file and saves it through the local service. */
export async function save(f: ReturnType<typeof fixture>) {
  const result = await compileOrThrow(f.file);

  return saveBody(f, { ...result, source: { path: f.file, workspace: f.cwd }, replace: false });
}
