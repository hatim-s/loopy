import { realpath } from "node:fs/promises";
import { macBundle } from "./bundle-darwin.js";
import { linuxBundle } from "./bundle-linux.js";
import { executable } from "./paths.js";

export async function bundleLauncher(
  bundle: string,
  workspace: string,
  network: boolean,
): Promise<[string, string[]]> {
  const bun = await realpath(process.execPath);

  if (process.platform === "darwin" && (await executable("/usr/bin/sandbox-exec"))) {
    return macBundle(bundle, workspace, bun, network);
  }

  if (process.platform === "linux" && (await executable("/usr/bin/bwrap"))) {
    return linuxBundle(bundle, workspace, bun, network);
  }

  throw new Error("Bundle execution requires sandbox-exec on macOS or bubblewrap on Linux.");
}
