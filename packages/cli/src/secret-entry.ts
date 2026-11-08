import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { MAX_SECRET_VALUE_BYTES } from "@loopy/contract";
import { Effect } from "effect";
import { CliError } from "./errors";

const LINE_ENDING_BYTES = 2;

const readPipedSecret = Effect.suspend(() => {
  if (process.stdin.isTTY) {
    return Effect.fail(
      new CliError({
        message: "--stdin requires piped input. Omit it to enter a secret privately.",
      }),
    );
  }

  return Effect.callback<string, CliError>((resume) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;

    const complete = (result: Effect.Effect<string, CliError>) => {
      if (finished) {
        return;
      }

      release();
      resume(result);
    };

    const data = (chunk: Buffer) => {
      bytes += chunk.length;

      if (bytes > MAX_SECRET_VALUE_BYTES + LINE_ENDING_BYTES) {
        complete(
          Effect.fail(
            new CliError({
              message: `Secret input exceeds ${MAX_SECRET_VALUE_BYTES / 1024} KiB.`,
            }),
          ),
        );
      } else {
        chunks.push(chunk);
      }
    };

    const end = () =>
      complete(
        Effect.succeed(
          Buffer.concat(chunks)
            .toString("utf8")
            .replace(/\r?\n$/, ""),
        ),
      );

    const error = (cause: Error) =>
      complete(Effect.fail(new CliError({ message: "Secret input failed.", cause })));

    const release = () => {
      if (finished) {
        return;
      }

      finished = true;
      process.stdin.removeListener("data", data);
      process.stdin.removeListener("end", end);
      process.stdin.removeListener("error", error);
      process.stdin.pause();
    };

    process.stdin.on("data", data);
    process.stdin.once("end", end);
    process.stdin.once("error", error);
    process.stdin.resume();

    return Effect.sync(release);
  });
});

const readHiddenSecret = Effect.scoped(
  Effect.gen(function* () {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      return yield* new CliError({
        message: "Secret entry requires a terminal. Pipe the value with --stdin for automation.",
      });
    }

    const terminal = yield* Effect.acquireRelease(
      Effect.sync(() => {
        // A muted sink prevents readline from echoing secret characters.
        const muted = new Writable({
          write(...[, , done]) {
            done();
          },
        });

        const dataListeners = process.stdin.listeners("data");

        const reader = createInterface({
          input: process.stdin,
          output: muted,
          terminal: true,
          historySize: 0,
        });

        process.stderr.write("Secret value (hidden): ");

        const ownedDataListeners = process.stdin
          .listeners("data")
          .filter((listener) => !dataListeners.includes(listener));

        return { reader, muted, ownedDataListeners };
      }),
      ({ reader, muted, ownedDataListeners }) =>
        Effect.sync(() => {
          reader.close();

          // The executable reads one hidden secret per process; remove only listeners created by this reader.
          for (const listener of ownedDataListeners) {
            process.stdin.removeListener("data", listener);
          }

          muted.end();
          process.stderr.write("\n");
        }),
    );

    return yield* Effect.callback<string, CliError>((resume) => {
      const line = (value: string) => resume(Effect.succeed(value));
      const close = () => resume(Effect.fail(new CliError({ message: "Secret entry cancelled." })));
      const interrupt = () => terminal.reader.close();
      terminal.reader.once("line", line);
      terminal.reader.once("close", close);
      terminal.reader.once("SIGINT", interrupt);

      return Effect.sync(() => {
        terminal.reader.removeListener("line", line);
        terminal.reader.removeListener("close", close);
        terminal.reader.removeListener("SIGINT", interrupt);
      });
    });
  }),
);

export const readSecret = (fromStdin: boolean) => (fromStdin ? readPipedSecret : readHiddenSecret);
