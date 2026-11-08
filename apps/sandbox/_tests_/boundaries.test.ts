import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import type { AuthorityInput } from "@loopy/contract/sandbox";
import { AuthorityError } from "@loopy/contract/sandbox";
import { Cause, Deferred, Effect, Exit, Fiber, Result } from "effect";
import { DockerBackend } from "../src/docker";
import { DockerClient } from "../src/docker/client";
import { FilesystemAuthority } from "../src/filesystem/authority";
import { HttpSandboxAuthority } from "../src/http-authority";
import { failure, SandboxOperationError } from "../src/operations";
import { SandboxRequestError } from "../src/request-error";
import { startSandbox } from "../src/server";
import { stateLayout } from "../src/state-root";
import { artifactReader, authorityFixture, successful, uncertain } from "./fixtures/authority";

async function fixture(run: (value: Awaited<ReturnType<typeof boundaryFixture>>) => Promise<void>) {
  await run(await boundaryFixture());
}

async function boundaryFixture() {
  const value = await authorityFixture();

  return {
    ...value,
    plan: await value.plan(),
    dependencies: {
      authority: value.authority,
      resultsFor: value.resultsFor,
      artifactReader,
      backend: {
        start: () => Effect.succeed(successful),
        recover: () => Effect.succeed(uncertain),
      },
      close: () => value.authority.close(),
    },
  };
}

test("HTTP composition uses fixture port zero and keeps error envelopes", () =>
  fixture(async ({ config, dependencies }) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* startSandbox(config, () => Effect.succeed(dependencies));

          const unauthorized = yield* Effect.promise(() =>
            fetch(new URL("/attempts", service.server.url)),
          );

          expect(unauthorized.status).toBe(401);

          const invalid = yield* Effect.promise(() =>
            fetch(new URL("/attempts", service.server.url), {
              method: "POST",
              headers: { Authorization: `Bearer ${config.token}` },
              body: "{}",
            }),
          );

          expect(invalid.status).toBe(400);
          expect(yield* Effect.promise(() => invalid.json())).toMatchObject({
            error: { code: "invalid_request" },
          });
        }),
      ),
    );
  }));

test("injected Docker absence yields uncertain result without reissuing work", () =>
  fixture(async ({ config, plan }) => {
    const commands: string[][] = [];

    const backend = new DockerBackend(
      config,
      new DockerClient(config, (argv) =>
        Effect.sync(() => {
          commands.push(argv);

          return {
            stdout: "",
            stderr: "",
            durationMs: 0,
            exitCode: argv.includes("inspect") ? 1 : 0,
          };
        }),
      ),
    );

    const result = await Effect.runPromise(backend.recover(plan));
    expect(result.kind === "failed" && result.error.code).toBe("uncertain");
    expect(commands.some((argv) => argv.includes("start") || argv.includes("create"))).toBe(false);
  }));

test("loopback authority HTTP keeps exact command and rejection envelopes", async () => {
  const seen: unknown[] = [];
  let reject = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      expect(request.headers.get("X-Loopy-Receipts-Namespace")).toBe("fixture");
      seen.push(await request.json());

      return reject
        ? Response.json({ error: "stale_session" }, { status: 409 })
        : Response.json({ epoch: 0 });
    },
  });

  try {
    const authority = new HttpSandboxAuthority({
      url: server.url.origin,
      token: "fixture",
      namespace: "fixture",
    });

    expect(await Effect.runPromise(authority.status({}))).toEqual({ epoch: 0 });
    reject = true;
    const result = await Effect.runPromise(authority.status({}).pipe(Effect.result));
    expect(
      Result.isFailure(result) && result.failure instanceof AuthorityError && result.failure.code,
    ).toBe("stale_session");
    expect(seen).toEqual([
      { operation: "status", input: {} },
      { operation: "status", input: {} },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("HTTP export cleanup takes precedence when reading and release both fail", () =>
  fixture(async ({ config, dependencies, request, plan }) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* startSandbox(config, () =>
            Effect.succeed({
              ...dependencies,
              artifactReader: {
                read: () => Effect.fail(new SandboxRequestError("not_found", "Missing artifact")),
                cleanup: () => Effect.fail(failure("cleanup", new Error("Helper remains"))),
              },
            }),
          );

          yield* service.attempts.start(request);
          yield* service.attempts.drain();
          const url = new URL("/artifacts", service.server.url);
          url.search = new URLSearchParams({
            workspace: request.workspace,
            key: JSON.stringify(request.executionKey),
            attempt: "1",
            path: "out.txt",
          }).toString();

          const response = yield* Effect.promise(() =>
            fetch(url, { headers: { Authorization: `Bearer ${config.token}` } }),
          );

          expect(response.status).toBe(409);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            error: { code: "conflict" },
          });

          const result = yield* service.attempts
            .artifact({ ...request, path: "out.txt" })
            .pipe(Effect.exit);

          expect(Exit.isFailure(result)).toBe(true);
          expect(
            (yield* dependencies.authority.exportGuards({
              after: null,
              limit: 200,
              volume: plan.volume,
            })).exports,
          ).toHaveLength(1);
        }),
      ),
    );
  }));

test("failed HTTP startup releases dependencies and permits retry within the same scope", () =>
  fixture(async ({ config, dependencies }) => {
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("fixture"),
    });

    let closes = 0;

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const failed = yield* startSandbox({ ...config, port: occupied.port! }, () =>
              Effect.succeed({
                ...dependencies,
                close: () =>
                  Effect.sync(() => {
                    closes++;
                  }),
              }),
            ).pipe(Effect.result);

            expect(Result.isFailure(failed)).toBe(true);
            expect(closes).toBe(1);

            const service = yield* startSandbox(config, () =>
              Effect.succeed({
                ...dependencies,
                close: () =>
                  Effect.sync(() => {
                    closes++;
                  }),
              }),
            );

            expect(service.server.port).toBeGreaterThan(0);
          }),
        ),
      );
      expect(closes).toBe(2);
    } finally {
      await occupied.stop(true);
    }
  }));

test("interrupted request leaves admitted work owned and concurrent close waits for release", () =>
  fixture(async ({ config, dependencies, request }) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();

          const admitted = yield* Deferred.make<void>();
          const reply = yield* Deferred.make<void>();

          class DelayedResponse extends FilesystemAuthority {
            override admit(input: AuthorityInput<"admit">) {
              return super.admit(input).pipe(
                Effect.tap(() => Deferred.succeed(admitted, undefined)),
                Effect.tap(() => Deferred.await(reply)),
              );
            }
          }

          const authority = new DelayedResponse(config.stateRoot);

          const service = yield* startSandbox(config, () =>
            Effect.succeed({
              ...dependencies,
              authority,
              close: () => authority.close(),
              backend: {
                start: () =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(finish)),
                    Effect.as(successful),
                  ),
                recover: () => Effect.succeed(uncertain),
              },
            }),
          );

          const caller = yield* service.attempts.start(request).pipe(Effect.forkChild);
          yield* Deferred.await(admitted);
          yield* Fiber.interrupt(caller);
          yield* Deferred.succeed(reply, undefined);
          yield* Deferred.await(entered);
          let closed = 0;

          const close = () =>
            service.attempts.close().pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  closed++;
                }),
              ),
            );

          const first = yield* close().pipe(Effect.forkChild);
          const second = yield* close().pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(closed).toBe(0);
          expect(
            yield* Effect.promise(() => Bun.file(stateLayout(config.stateRoot).lock).exists()),
          ).toBe(true);
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          expect(closed).toBe(2);
        }),
      ),
    );
  }));

test("interrupted injected Docker transport removes its owned staging directory", () =>
  fixture(async ({ config, request, plan }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();

        const backend = new DockerBackend(
          config,
          new DockerClient(config, () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );

        const worker = yield* backend.start(plan, request).pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        yield* Fiber.interrupt(worker);
        const exit = yield* Fiber.await(worker);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(yield* Effect.promise(() => readdir(stateLayout(config.stateRoot).staging))).toEqual(
          [],
        );
      }),
    );
  }));

for (const target of ["attempts", "server"] as const) {
  test(`interrupted ${target} close caller cannot discard a dependency release failure`, () =>
    fixture(async ({ config, dependencies }) => {
      let releases = 0;

      const exit = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const finish = yield* Deferred.make<void>();

            const service = yield* startSandbox(config, () =>
              Effect.succeed({
                ...dependencies,
                close: () =>
                  Effect.gen(function* () {
                    releases++;
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(finish);

                    return yield* Effect.fail(
                      failure("dependency release", new Error("Release unavailable")),
                    );
                  }),
              }),
            );

            const close = () =>
              target === "attempts" ? service.attempts.close() : service.close();

            const first = yield* close().pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            const interrupting = yield* Fiber.interrupt(first).pipe(Effect.forkChild);
            yield* Deferred.succeed(finish, undefined);
            yield* Fiber.join(interrupting);
            const later = yield* close().pipe(Effect.exit);
            expect(Exit.isFailure(later)).toBe(true);

            if (Exit.isFailure(later)) {
              const errors = later.cause.reasons
                .filter(Cause.isFailReason)
                .map((reason) => reason.error);

              expect(errors).toHaveLength(1);
              expect(errors[0]).toBeInstanceOf(SandboxOperationError);
            }

            expect(releases).toBe(1);
          }),
        ).pipe(Effect.exit),
      );

      // The owning scope also receives the same failed release, rather than a clean second close.
      expect(Exit.isFailure(exit)).toBe(true);
    }));
}
