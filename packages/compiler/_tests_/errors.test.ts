import { expect, test } from "bun:test";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { qualityTestRoot } from "../../runtime/_tests_/fixtures/quality-test-root";
import { compile } from "../src";
import { authorFailure, CompilationError, recoverDiagnostics } from "../src/errors";

test("unreadable compiler input is an infrastructure failure, not an author diagnostic", async () => {
  const exit = await Effect.runPromiseExit(
    compile(join(qualityTestRoot("compile-missing"), "missing.ts")),
  );

  expect(exit).toMatchObject({
    _tag: "Failure",
    cause: {
      reasons: [{ _tag: "Fail", error: { _tag: "CompilationError", operation: "resolve entry" } }],
    },
  });
});

{
  const error = authorFailure("evaluation_failed", "fixture.ts", "author failure");

  test("diagnostic recovery preserves cleanup, defects and interruption", async () => {
    const cleanup = new CompilationError({
      operation: "remove compiler scratch",
      file: "scratch",
      cause: new Error("denied"),
    });

    const combined = Effect.acquireUseRelease(
      Effect.void,
      () => Effect.fail(error),
      () => Effect.fail(cleanup),
    );

    const exit = await Effect.runPromiseExit(recoverDiagnostics(combined, "fixture.ts"));
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: {
        reasons: [
          {
            _tag: "Fail",
            error: {
              _tag: "CompilationError",
              operation: "compile with concurrent failures",
              cause: {
                reasons: [
                  { _tag: "Fail", error },
                  { _tag: "Fail", error: cleanup },
                ],
              },
            },
          },
          { _tag: "Fail", error: cleanup },
        ],
      },
    });
    const single = await Effect.runPromise(recoverDiagnostics(Effect.fail(error), "fixture.ts"));
    expect(single).toMatchObject({
      ok: false,
      diagnostics: [{ message: "author failure", file: "fixture.ts" }],
    });

    const mixedCause = Cause.fromReasons([
      ...Cause.fail(error).reasons,
      ...Cause.die("bug").reasons,
      ...Cause.interrupt().reasons,
    ]);

    const mixed = await Effect.runPromiseExit(
      recoverDiagnostics(Effect.failCause(mixedCause), "fixture.ts"),
    );

    expect(Exit.isFailure(mixed) && mixed.cause.reasons.slice(1)).toEqual(
      mixedCause.reasons.filter((reason) => reason._tag !== "Fail"),
    );

    if (Exit.isFailure(mixed)) {
      expect(mixed.cause.reasons[0]).toMatchObject({
        _tag: "Fail",
        error: { _tag: "CompilationError", cause: mixedCause },
      });
    }
  });
}
