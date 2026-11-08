import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@loopy/compiler";
import { Cause, Effect, Exit } from "effect";
import { authorFailure, CompilationError, recoverDiagnostics } from "../../compiler/src/errors";
import { Registry } from "../src/local/registry";
import { makeArtifactRegistry, saveCompiled } from "../src/local/save-compiled";
import { generateCommand } from "../src/local/typegen/generate";
import { compiledBody } from "./fixtures/compiled";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loopy-compilation-effects-"));
  roots.push(root);
  mkdirSync(join(root, ".loopy", "loopies"), { recursive: true });
  const registry = Effect.runSync(Registry.make(join(root, "home"), root));

  return { root, registry };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("save validates before publication and pins a private historical graph", async () => {
  const { root, registry } = fixture();
  const body = await compiledBody("saved", join(root, "saved.ts"));
  const saved = await Effect.runPromise(saveCompiled(registry, body));
  expect(saved.revision).toBe(body.revision);
  expect(statSync(registry.graphPath(body.revision)).mode & 0o777).toBe(0o600);
  const historical = readFileSync(registry.graphPath(body.revision), "utf8");
  const invalid = { ...body, revision: "a".repeat(64) };
  const exit = await Effect.runPromiseExit(saveCompiled(registry, invalid));
  expect(exit).toMatchObject({
    _tag: "Failure",
    cause: { reasons: [{ _tag: "Fail", error: { _tag: "ArtifactValidationError" } }] },
  });
  expect(Effect.runSync(registry.get("saved"))?.revision).toBe(body.revision);
  expect(readFileSync(registry.graphPath(body.revision), "utf8")).toBe(historical);
  expect(await Effect.runPromise(makeArtifactRegistry(registry).get("absent"))).toBeNull();
});

test("publication failure leaves the previous registry identity intact", async () => {
  const { root, registry } = fixture();
  const source = join(root, "saved.ts");
  const first = await compiledBody("saved", source);
  await Effect.runPromise(saveCompiled(registry, first));
  const before = readFileSync(join(registry.projectDirectory, "saved.json"), "utf8");
  const changed = await compiledBody("saved", source, { description: "changed" });
  rmSync(join(registry.home, "graphs"), { recursive: true });
  writeFileSync(join(registry.home, "graphs"), "not a directory");
  expect(await Effect.runPromiseExit(saveCompiled(registry, changed))).toMatchObject({
    _tag: "Failure",
    cause: {
      reasons: [
        { _tag: "Fail", error: { _tag: "RegistryError", operation: "create graph directory" } },
      ],
    },
  });
  expect(readFileSync(join(registry.projectDirectory, "saved.json"), "utf8")).toBe(before);
});

test("unreadable compiler input is an infrastructure failure, not an author diagnostic", async () => {
  const { root } = fixture();
  const exit = await Effect.runPromiseExit(compile(join(root, "missing.ts")));
  expect(exit).toMatchObject({
    _tag: "Failure",
    cause: {
      reasons: [{ _tag: "Fail", error: { _tag: "CompilationError", operation: "resolve entry" } }],
    },
  });
});

test("typegen preserves help printed by a nonzero command and types spawn failure", async () => {
  const { root } = fixture();
  const binary = join(root, "fixture-cli");
  writeFileSync(binary, '#!/bin/sh\necho "usage: fixture" >&2\nexit 1\n', { mode: 0o755 });
  expect((await Effect.runPromise(generateCommand(binary, []))).help).toBe("usage: fixture");
  const failure = await Effect.runPromiseExit(generateCommand(join(root, "missing"), []));
  expect(failure).toMatchObject({
    _tag: "Failure",
    cause: { reasons: [{ _tag: "Fail", error: { _tag: "TypeGenerationError" } }] },
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

test("persisted entries retain slug validation", async () => {
  const { root, registry } = fixture();
  const body = await compiledBody("saved", join(root, "saved.ts"));
  const entry = await Effect.runPromise(saveCompiled(registry, body));
  writeFileSync(
    join(registry.projectDirectory, "saved.json"),
    JSON.stringify({ ...entry, slug: "../escaped" }),
  );
  expect(await Effect.runPromiseExit(registry.list())).toMatchObject({
    _tag: "Failure",
    cause: {
      reasons: [{ _tag: "Fail", error: { _tag: "RegistryError", operation: "list definitions" } }],
    },
  });
});
