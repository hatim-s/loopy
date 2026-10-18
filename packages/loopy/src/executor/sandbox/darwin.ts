import type { PathRule, SandboxSpec } from "./spec.js";

function sbpl(path: string): string {
  if (/\p{Cc}/u.test(path)) {
    throw new Error("Paths with control characters cannot be sandboxed.");
  }

  return JSON.stringify(path);
}

function filter(rule: PathRule) {
  return `(${rule.kind === "subpath" ? "subpath" : "literal"} ${sbpl(rule.path)})`;
}

export function darwinProfile(spec: SandboxSpec): string {
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    // Bun resolves executables and bundles by enumerating their ancestor directories.
    "(allow file-read-metadata)",
    ...spec.read.flatMap((rule) => [
      `(allow ${rule.kind === "directory" ? "file-read-data" : "file-read*"} ${filter(rule)})`,
      ...(rule.hidden ?? []).map((path) => `(deny file-read* (subpath ${sbpl(path)}))`),
    ]),
    ...spec.write.map((rule) => `(allow file-write* ${filter(rule)})`),
    '(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/tty"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))',
    ...spec.denied.map((path) => `(deny file-read* file-write* (subpath ${sbpl(path)}))`),
    spec.network ? "(allow network*)" : "(deny network*)",
  ].join("\n");
}
