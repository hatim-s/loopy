import { constants } from "node:fs";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandResult, type ExecutionMode } from "../../core/index.js";
import { canonicalPath, ENV_EXEC, envArgs, executable } from "../paths.js";
import { darwinProfile } from "./darwin.js";
import { linuxArgs } from "./linux.js";
import { bundleSpec, commandSpec, compilerSpec, type SandboxSpec } from "./spec.js";

let sandbox: Promise<{ platform: "darwin" | "linux"; tool: string }> | undefined;

export function findSandbox() {
  sandbox ??= (async () => {
    const platform = process.platform;

    const candidates =
      platform === "darwin"
        ? ["/usr/bin/sandbox-exec"]
        : platform === "linux"
          ? ["/usr/bin/bwrap", "/bin/bwrap"]
          : [];

    for (const tool of candidates) {
      if ((platform === "darwin" || platform === "linux") && (await executable(tool))) {
        return { platform, tool };
      }
    }

    throw new Error("Execution requires sandbox-exec on macOS or bubblewrap on Linux.");
  })();

  return sandbox;
}

async function render(
  spec: SandboxSpec,
  cwd: string,
  program: string,
  argv: string[],
): Promise<[string, string[]]> {
  const { platform, tool } = await findSandbox();

  return [
    tool,
    platform === "darwin"
      ? ["-p", darwinProfile(spec), program, ...argv]
      : [...(await linuxArgs(spec, cwd)), "--", program, ...argv],
  ];
}

export async function sandboxLauncher(options: {
  program: string;
  workspace: string;
  cwd: string;
  scratch: string;
  env: NodeJS.ProcessEnv;
  helper?: string;
  protectedHome: string;
  mode: ExecutionMode;
}) {
  return render(await commandSpec(options), options.cwd, ENV_EXEC, [
    "-i",
    "--",
    ...envArgs(options.env),
    options.helper ?? options.program,
  ]);
}

export async function withBundleSandbox(
  options: { bundle: string; workspace: string; home: string } & (
    | { purpose: "compiler" }
    | { purpose: "bundle"; network: boolean }
  ),
  execute: (launch: { program: string; args: string[] }) => Promise<CommandResult>,
): Promise<CommandResult> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "loopy-bundle-")));
  const bundle = join(directory, "bundle.js");

  try {
    // Bun enumerates bundle ancestors, so stage pinned bytes outside the daemon home.
    await copyFile(options.bundle, bundle, constants.COPYFILE_EXCL);
    const bun = await realpath(process.execPath);

    const home = canonicalPath(options.home);

    const paths = { bundle, bun, workspace: options.workspace, home };

    const spec =
      options.purpose === "compiler"
        ? await compilerSpec(paths)
        : await bundleSpec({ ...paths, network: options.network });

    const [program, args] = await render(spec, options.workspace, bun, ["--smol", bundle]);

    return await execute({ program, args });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
