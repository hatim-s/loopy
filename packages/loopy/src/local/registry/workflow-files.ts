import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalPath } from "../fs.js";

export const SKIPPED_DIRECTORIES = ["node_modules", "dist", "coverage"];

/** The nearest ancestor holding `.loopy/workflows`, or the directory itself. */
export function projectRoot(cwd: string): string {
  let directory = canonicalPath(cwd);
  while (true) {
    if (existsSync(join(directory, ".loopy", "workflows"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return canonicalPath(cwd);
    }
    directory = parent;
  }
}

/** Every `*.loopy.ts` below `root` in a stable order, skipping hidden and build directories. */
export function findWorkflowFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (path: string) => {
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.includes(entry.name)) {
        continue;
      }
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".loopy.ts")) {
        files.push(child);
      }
    }
  };
  walk(root);
  return files;
}
