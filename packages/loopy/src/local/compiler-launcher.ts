import { executable } from "./sandbox/paths.js";

export async function compilerLauncher(program: string, cwd: string): Promise<[string, string[]]> {
  if (process.platform === "darwin" && (await executable("/usr/bin/sandbox-exec"))) {
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process-exec)",
      "(allow sysctl-read)",
      "(allow file-read*)",
      `(allow file-write* (subpath ${JSON.stringify(cwd)}))`,
      '(allow file-write* (literal "/dev/null"))',
      "(deny network*)",
    ].join("\n");

    return ["/usr/bin/sandbox-exec", ["-p", profile, program]];
  }

  if (process.platform === "linux" && (await executable("/usr/bin/bwrap"))) {
    return [
      "/usr/bin/bwrap",
      [
        "--die-with-parent",
        "--unshare-all",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--bind",
        cwd,
        cwd,
        "--chdir",
        cwd,
        "--",
        program,
      ],
    ];
  }

  throw new Error("The compiler requires sandbox-exec on macOS or bubblewrap on Linux.");
}
