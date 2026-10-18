import { constants } from "node:fs";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../../core/index.js";
import { macBundle } from "./bundle-darwin.js";
import { linuxBundle } from "./bundle-linux.js";
import { executable } from "./paths.js";

type Options = { bundle: string; workspace: string; network: boolean; home: string };

export type BundleSandboxOptions = Options & { bun: string };

export async function withBundleSandbox(
  options: Options,
  execute: (launch: { program: string; args: string[] }) => Promise<CommandResult>,
): Promise<CommandResult> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "loopy-bundle-")));
  const bundle = join(directory, "bundle.js");

  try {
    // Bun enumerates bundle ancestors, so stage the pinned bytes outside the private daemon home.
    await copyFile(options.bundle, bundle, constants.COPYFILE_EXCL);
    const [program, args] = await launcher({ ...options, bundle });

    return await execute({ program, args });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function launcher({
  bundle,
  workspace,
  network,
  home,
}: Options): Promise<[string, string[]]> {
  const bun = await realpath(process.execPath);

  if (process.platform === "darwin" && (await executable("/usr/bin/sandbox-exec"))) {
    return macBundle({ bundle, workspace, bun, network, home });
  }

  if (process.platform === "linux" && (await executable("/usr/bin/bwrap"))) {
    return linuxBundle({ bundle, workspace, bun, network, home });
  }

  throw new Error("Bundle execution requires sandbox-exec on macOS or bubblewrap on Linux.");
}
