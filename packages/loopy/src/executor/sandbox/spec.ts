import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ExecutionMode } from "../../core/index.js";
import { packageDirectory, within } from "../paths.js";

export type PathRule = {
  path: string;
  kind: "literal" | "subpath" | "directory";
  hidden?: string[];
};

export type SandboxSpec = {
  read: PathRule[];
  write: PathRule[];
  denied: string[];
  network: boolean;
};

const subpath = (path: string): PathRule => ({ path, kind: "subpath" });

const literal = (path: string): PathRule => ({ path, kind: "literal" });

export async function bundleSpec(options: {
  bundle: string;
  workspace: string;
  bun: string;
  network: boolean;
  home: string;
}): Promise<SandboxSpec> {
  const { bundle, workspace, bun, network, home } = options;
  const directories = new Set<string>();

  for (const path of [bundle, bun, workspace]) {
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      directories.add(parent);

      if (parent === "/") {
        break;
      }
    }
  }

  const runtime = [
    "/usr/lib",
    "/usr/share/icu",
    "/lib",
    "/lib64",
    "/System/Library",
    "/private/var/db/dyld",
    "/private/var/db/timezone",
  ];

  const read = [literal(bundle), literal(bun), subpath(workspace)];

  for (const path of runtime) {
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    ) {
      read.push(subpath(path));
    }
  }

  return {
    read: [...directories].map((path): PathRule => ({ path, kind: "directory" })).concat(read),
    write: [subpath(workspace)],
    denied: [home],
    network,
  };
}

export async function compilerSpec(options: {
  bundle: string;
  workspace: string;
  bun: string;
  home: string;
}) {
  return bundleSpec({ ...options, network: false });
}

export async function commandSpec(options: {
  program: string;
  workspace: string;
  scratch: string;
  helper?: string;
  protectedHome: string;
  mode: ExecutionMode;
}): Promise<SandboxSpec> {
  const { program, workspace, scratch, helper, protectedHome, mode } = options;
  const home = await realpath(homedir());

  if (home === "/") {
    throw new Error("Sandbox mode requires a private home directory.");
  }

  const allowedPackage = within(workspace, program)
    ? undefined
    : await packageDirectory(program, home);

  return {
    read: [
      { path: "/", kind: "subpath", hidden: mode === "full" ? [] : [home, "/tmp", "/run"] },
      subpath(workspace),
      subpath(scratch),
      allowedPackage ? subpath(allowedPackage) : literal(program),
      ...(helper ? [literal(helper)] : []),
    ],
    write: mode === "full" ? [subpath("/")] : [subpath(workspace), subpath(scratch)],
    denied: [protectedHome],
    network: mode === "full",
  };
}
