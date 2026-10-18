import { stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { within } from "../paths.js";
import type { SandboxSpec } from "./spec.js";

export async function linuxArgs(spec: SandboxSpec, cwd: string): Promise<string[]> {
  const args = ["--die-with-parent", "--new-session", "--unshare-all"];

  if (spec.network) {
    args.push("--share-net");
  }

  const masks: string[] = [];
  const created = new Set<string>();

  const prepare = (target: string) => {
    const base = masks.find((mask) => within(mask, target));

    if (!base) {
      return;
    }

    let path = base;

    for (const part of relative(base, target).split(sep).filter(Boolean)) {
      path = join(path, part);

      if (!created.has(path)) {
        args.push("--dir", path);
        created.add(path);
      }
    }
  };

  for (const rule of [...spec.read, ...spec.write]) {
    if (rule.kind === "directory") {
      continue;
    }

    const stats = await stat(rule.path);
    prepare(stats.isDirectory() ? rule.path : dirname(rule.path));
    args.push(
      spec.write.some((write) => within(write.path, rule.path)) ? "--bind" : "--ro-bind",
      rule.path,
      rule.path,
    );

    for (const path of rule.hidden ?? []) {
      if (
        !(await stat(path).then(
          () => true,
          () => false,
        ))
      ) {
        continue;
      }

      prepare(path);
      args.push("--tmpfs", path);
      masks.unshift(path);
    }
  }

  for (const path of spec.denied) {
    prepare(path);
    args.push("--tmpfs", path, "--remount-ro", path);
  }

  args.push("--dev", "/dev", "--proc", "/proc", "--chdir", cwd);

  return args;
}
