import { dirname } from "node:path";

export function macBundle(
  bundle: string,
  workspace: string,
  bun: string,
  network: boolean,
): [string, string[]] {
  const quote = JSON.stringify;
  const directories = new Set<string>();

  for (const path of [bundle, bun, workspace]) {
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      directories.add(parent);

      if (parent === "/") {
        break;
      }
    }
  }

  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    // Bun resolves the executable and bundle by reading their ancestor directories.
    "(allow file-read-metadata)",
    `(allow file-read-data ${[...directories].map((path) => `(literal ${quote(path)})`).join(" ")})`,
    `(allow file-read* (literal ${quote(bundle)}) (literal ${quote(bun)}) (subpath ${quote(workspace)}) (subpath "/usr/lib") (subpath "/System/Library") (subpath "/private/var/db/dyld") (subpath "/private/var/db/timezone"))`,
    `(allow file-write* (subpath ${quote(workspace)}) (literal "/dev/null"))`,
    '(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/urandom") (literal "/dev/random"))',
    network ? "(allow network*)" : "(deny network*)",
  ].join("\n");

  return ["/usr/bin/sandbox-exec", ["-p", profile, bun, "--smol", bundle]];
}
