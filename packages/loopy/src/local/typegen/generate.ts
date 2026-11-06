import { execFile } from "node:child_process";
import { basename } from "node:path";
import { Data, Effect } from "effect";
import { errorMessage } from "../../core";
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

/** Combined stdout and stderr, since many CLIs print help to stderr or exit nonzero. */
export function outputOf(binary: string, args: string[]) {
  return Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          binary,
          args,
          { encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576, signal },
          (error, stdout, stderr) => {
            const output = `${stdout}\n${stderr}`.trim();

            if (error && !output) {
              reject(error);
            } else {
              resolve(output);
            }
          },
        );
      }),
    catch: (cause) => new TypeGenerationError({ binary, args, cause }),
  });
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
  const descriptor = { ...parsed.descriptor, observedVersion: version.split("\n")[0] ?? version };

  return { source: renderCommandSource(name, descriptor), help, warnings: parsed.warnings };
});
