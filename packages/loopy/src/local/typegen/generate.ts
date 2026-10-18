import { basename } from "node:path";
import { spawnCaptured, withCommandSandbox } from "../../executor/index.js";
import { identifier } from "./names.js";
import { parseCliHelp } from "./parse-help.js";
import { renderCommandSource } from "./render.js";

type GenerationOptions = { name: string | null; workspace: string; home: string };

async function outputOf(
  binary: string,
  args: string[],
  options: GenerationOptions,
): Promise<string> {
  const result = await withCommandSandbox(
    { program: binary, args },
    { workspace: options.workspace, protectedHome: options.home, mode: "sandbox" },
    (launch) => spawnCaptured(launch, { timeoutMs: 10_000, maxOutputBytes: 1_048_576 }),
  );

  // Help can be on stderr or accompany a nonzero exit status.
  return `${result.stdout}\n${result.stderr}`.trim();
}

export async function generateCommand(
  binary: string,
  path: string[],
  options: GenerationOptions,
): Promise<{ source: string; warnings: string[] }> {
  const help = await outputOf(binary, [...path, "--help"], options);
  const version = await outputOf(binary, ["--version"], options).catch(() => "unknown");
  const parsed = parseCliHelp(binary, path, help);
  const name = options.name ?? identifier([basename(binary), ...path].join("-"));
  const descriptor = { ...parsed.descriptor, observedVersion: version.split("\n")[0] ?? version };

  return { source: renderCommandSource(name, descriptor), warnings: parsed.warnings };
}
