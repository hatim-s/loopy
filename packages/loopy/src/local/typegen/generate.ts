import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "../../core/index.js";
import { parseCliHelp } from "./parse-help.js";
import { identifier, renderCommandSource } from "./render.js";

const execFileAsync = promisify(execFile);

/** Combined stdout and stderr, since many CLIs print help to stderr or exit nonzero. */
export async function outputOf(binary: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(binary, args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_048_576,
    });
    return `${result.stdout}\n${result.stderr}`.trim();
  } catch (error) {
    const processError = error as Error & { stdout?: string; stderr?: string };
    const output = `${processError.stdout ?? ""}\n${processError.stderr ?? ""}`.trim();
    if (output) {
      return output;
    }
    throw new Error(`Could not run ${binary} ${args.join(" ")}: ${errorMessage(error)}`);
  }
}

export async function generateCommand(
  binary: string,
  path: string[],
  options: { name?: string } = {},
): Promise<{ source: string; help: string; warnings: string[] }> {
  const help = await outputOf(binary, [...path, "--help"]);
  const version = await outputOf(binary, ["--version"]).catch(() => "unknown");
  const parsed = parseCliHelp(binary, path, help);
  const name = options.name ?? identifier([basename(binary), ...path].join("-"));
  const descriptor = { ...parsed.descriptor, observedVersion: version.split("\n")[0] ?? version };
  return {
    source: renderCommandSource(name, descriptor),
    help,
    warnings: parsed.warnings,
  };
}
