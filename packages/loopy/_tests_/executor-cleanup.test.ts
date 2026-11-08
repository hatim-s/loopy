import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CommandExecutionError } from "@loopy/runtime/os";
import { Effect } from "effect";
import { withBundleSandbox } from "../../runtime/src/os/sandbox/bundle";
import { fixture } from "./fixtures/executor";

for (const primary of ["timeout", "interrupt", "defect"] as const) {
  test(`bundle cleanup retains its diagnostic and the complete ${primary} Exit`, async () => {
    const f = await fixture();
    await Bun.write(f.bundle, "fixture");
    let directory: string | undefined;
    let cleanupObserved = false;

    const operation = withBundleSandbox(
      { bundle: f.bundle, workspace: f.workspace, home: f.home, network: false },
      ({ args }) =>
        Effect.gen(function* () {
          const bundle = args.at(-1);

          if (bundle === undefined) {
            return yield* Effect.die(new Error("Expected staged bundle argument."));
          }

          directory = dirname(bundle);
          const locked = join(directory, "locked");
          mkdirSync(locked);
          writeFileSync(join(locked, "file"), "fixture");
          chmodSync(locked, 0);

          if (primary === "interrupt") {
            return yield* Effect.interrupt;
          }

          if (primary === "defect") {
            return yield* Effect.die(new Error("fixture defect"));
          }

          return yield* Effect.fail(
            new CommandExecutionError({
              reason: "timeout",
              message: "fixture timeout",
              output: { stdout: "captured", stderr: "", exitCode: -1, durationMs: 1 },
            }),
          );
        }),
    );

    try {
      const exit = await Effect.runPromise(
        operation.pipe(
          Effect.catchTag("BundleCleanupError", (error) => {
            cleanupObserved = true;
            expect(error.cause).toMatchObject({ _tag: "ProcessFilesystemError" });

            return error.primary;
          }),
          Effect.exit,
        ),
      );

      expect(cleanupObserved).toBe(true);
      expect(exit).toMatchObject({ _tag: "Failure" });

      if (exit._tag !== "Failure") {
        throw new Error("Expected the primary failure.");
      }

      if (primary === "timeout") {
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "CommandExecutionError",
              reason: "timeout",
              output: expect.objectContaining({ stdout: "captured" }),
            }),
          }),
        );
      }

      if (primary === "interrupt") {
        expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ _tag: "Interrupt" }));
      }

      if (primary === "defect") {
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Die",
            defect: expect.objectContaining({ message: "fixture defect" }),
          }),
        );
      }
    } finally {
      if (directory !== undefined) {
        chmodSync(join(directory, "locked"), 0o700);
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
}
