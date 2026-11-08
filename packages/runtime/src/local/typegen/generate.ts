import { createHash } from "node:crypto";
import { basename } from "node:path";
import { type CommandResult, errorMessage } from "@loopy/core";
import { Data, Effect } from "effect";
import { spawnCaptured } from "../../os";
import { identifier } from "./names";
import { parseCliHelp } from "./parse-help";
import { renderCommandSource } from "./render";

export class TypeGenerationError extends Data.TaggedError("TypeGenerationError")<{
  binary: string;
  args: string[];
  cause: unknown;
}> {
  override get message() {
    return `Could not run ${this.binary} ${this.args.join(" ")}. ${errorMessage(this.cause)}`;
  }
}

const combined = ({ stdout, stderr }: CommandResult) => `${stdout}\n${stderr}`.trim();

/** Many CLIs print help to stderr or exit nonzero, so any captured output counts. */
function outputOf(binary: string, args: string[]) {
  return spawnCaptured(
    { program: binary, args, cwd: process.cwd(), env: process.env },
    { timeoutMs: 10_000, maxOutputBytes: 1_048_576 },
  ).pipe(
    Effect.map(combined),
    Effect.catchTag("CommandExecutionError", (cause) =>
      combined(cause.output)
        ? Effect.succeed(combined(cause.output))
        : Effect.fail(new TypeGenerationError({ binary, args, cause })),
    ),
  );
}

export const generateCommand = Effect.fn(function* (
  binary: string,
  path: string[],
  options: { name?: string } = {},
) {
  const help = yield* outputOf(binary, [...path, "--help"]);

  // Version is advisory. Failure to obtain help remains a typed failure.
  const version = yield* outputOf(binary, ["--version"]).pipe(
    Effect.catchTag("TypeGenerationError", () => Effect.succeed("unknown")),
  );

  const parsed = parseCliHelp(binary, path, help);
  const name = options.name ?? identifier([basename(binary), ...path].join("-"));

  const header = [
    `// Generated from \`${[binary, ...path, "--help"].join(" ")}\`.`,
    `// Help sha256: ${createHash("sha256").update(help).digest("hex")}`,
    `// Observed version: ${version.split("\n")[0] ?? version}`,
  ].join("\n");

  return {
    source: `${header}\n${renderCommandSource(name, parsed.descriptor)}`,
    help,
    warnings: parsed.warnings,
  };
});
