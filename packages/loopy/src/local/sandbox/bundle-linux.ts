import { stat } from "node:fs/promises";
import type { BundleSandboxOptions } from "./bundle.js";

export async function linuxBundle({
  bundle,
  workspace,
  bun,
  network,
  home,
}: BundleSandboxOptions): Promise<[string, string[]]> {
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
    "--bind",
    workspace,
    workspace,
    "--tmpfs",
    home,
    "--ro-bind",
    bun,
    bun,
    "--ro-bind",
    bundle,
    bundle,
    "--remount-ro",
    home,
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
