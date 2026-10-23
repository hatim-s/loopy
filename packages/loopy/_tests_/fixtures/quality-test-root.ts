import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function qualityTestRoot(prefix: string) {
  // Keep test state inside this checkout and stop registry lookup before ancestor projects.
  const parent = resolve(import.meta.dir, "../../../..", ".loopy/quality-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, `${prefix}-`));
  await mkdir(join(directory, ".loopy/loopies"), { recursive: true });

  return directory;
}
