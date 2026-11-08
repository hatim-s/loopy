import { resolve } from "node:path";

export const CLI = resolve(import.meta.dir, "../../src/index.ts");

interface Place {
  readonly cwd: string;
  readonly home: string;
}

/** Spawns the CLI with PATH and the fixture's own directories as its whole environment. */
export function spawnCli<In extends "pipe" | "ignore" | ReadableStream<Uint8Array>>(
  { cwd, home }: Place,
  args: readonly string[],
  stdin: In,
) {
  return Bun.spawn([process.execPath, "--no-env-file", CLI, "--home", home, ...args], {
    cwd,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: cwd, TMPDIR: cwd, LOOPY_HOME: home },
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function cli(place: Place, ...args: string[]) {
  const child = spawnCli(place, args, "ignore");

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, code };
}
