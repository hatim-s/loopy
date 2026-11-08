type Environment = Record<string, string | undefined>;

/** The `ps -o` columns for one pid, or null once that pid is gone. */
export async function processFields(pid: number, format: string, env?: Environment) {
  const child = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", format], {
    stdout: "pipe",
    stderr: "ignore",
    env,
  });

  const output = await new Response(child.stdout).text();

  return (await child.exited) === 0 ? output.trim() : null;
}

/** Every pid under the roots, the roots included, from one snapshot of the process table. */
export async function processTree(roots: readonly number[], env?: Environment) {
  const child = Bun.spawn(["/bin/ps", "-axo", "pid=,ppid="], {
    stdout: "pipe",
    stderr: "ignore",
    env,
  });

  const output = await new Response(child.stdout).text();

  if ((await child.exited) !== 0) {
    throw new Error("The process table could not be read with ps.");
  }

  const rows = output.split("\n").flatMap((row) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);

    return match ? [{ pid: Number(match[1]), parent: Number(match[2]) }] : [];
  });

  const tree = new Set(roots);

  for (let added = true; added; ) {
    added = false;

    for (const row of rows) {
      if (tree.has(row.parent) && !tree.has(row.pid)) {
        tree.add(row.pid);
        added = true;
      }
    }
  }

  return tree;
}
