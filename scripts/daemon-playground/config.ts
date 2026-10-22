import { resolve } from "node:path";

export const root = resolve(import.meta.dir, "../..");

export const state = resolve(root, ".loopy/playground-daemon");

export const home = resolve(state, "home");

export const source = resolve(state, "loopies-playground");

export const upstream = resolve(root, ".loopy/playground/loopies-playground");

export const evidence = resolve(root, ".notes/cloud/evidence");

export const port = 15170;

export const cli = resolve(root, "packages/loopy/src/cli/index.ts");

export const selected = [
  { group: "a", slug: "playground-a-lint-report" },
  { group: "b", slug: "playground-b-parallel-build" },
  { group: "b", slug: "playground-b-retry-marker" },
  { group: "c", slug: "playground-c-repository-validation" },
  { group: "c", slug: "playground-c-security-review" },
] as const;

export function environment() {
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    HOME: resolve(state, "process-home"),
    LOOPY_HOME: home,
  };
}

export async function writeEvidence<T>(name: string, value: T) {
  await Bun.write(
    resolve(evidence, `playground-daemon${name}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
