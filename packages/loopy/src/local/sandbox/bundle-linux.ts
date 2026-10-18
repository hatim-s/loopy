import { stat } from "node:fs/promises";

export async function linuxBundle(
  bundle: string,
  workspace: string,
  bun: string,
  network: boolean,
): Promise<[string, string[]]> {
  const args = ["--die-with-parent", "--unshare-all"];

  if (network) {
    args.push("--share-net");
  }

  for (const directory of ["/usr/lib", "/lib", "/lib64"]) {
    if (
      await stat(directory)
        .then(() => true)
        .catch(() => false)
    ) {
      args.push("--ro-bind", directory, directory);
    }
  }

  args.push(
    "--ro-bind",
    bun,
    bun,
    "--ro-bind",
    bundle,
    bundle,
    "--bind",
    workspace,
    workspace,
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    workspace,
    "--",
    bun,
    "--smol",
    bundle,
  );

  return ["/usr/bin/bwrap", args];
}
