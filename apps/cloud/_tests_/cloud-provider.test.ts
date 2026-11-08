import { expect, test } from "bun:test";
import { CLOUD_MAX_REQUEST_BYTES, decodeBoundary, nodeIdSchema } from "@loopy/contract";
import { SANDBOX_MAX_BUNDLE_BYTES, SANDBOX_MAX_REQUEST_BYTES } from "@loopy/contract/sandbox";
import { RegistryError, readBoundedBody } from "@loopy/runtime/service";
import { Cause, Effect, Exit } from "effect";
import {
  artifactReader,
  authorityFixture,
  successful,
  uncertain,
} from "../../sandbox/_tests_/fixtures/authority";
import { startSandbox } from "../../sandbox/src/server";
import { readBoundedText } from "../src/http";
import { SandboxProvider } from "../src/provider";

const key = (runId: string) => ({ runId, nodeId: decodeBoundary(nodeIdSchema)("work"), scope: [] });

function providerFailure(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true);

  return Exit.isFailure(exit)
    ? exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
    : [];
}

test("provider transport failure is typed and cannot become an absent receipt", async () => {
  const artifacts = {
    getBundle: () =>
      Effect.fail(
        new RegistryError({
          operation: "fixture bundle",
          cause: "No bundle in this lookup-only fixture",
        }),
      ),
  };

  const provider = new SandboxProvider({
    url: new URL("http://127.0.0.1:1"),
    token: "synthetic",
    workspace: "alpha",
    artifacts,
  });

  const exit = await Effect.runPromiseExit(provider.lookup(key("transport"), 1));

  expect(providerFailure(exit)).toMatchObject([
    { _tag: "DurableProviderError", operation: "lookup", reason: "transport" },
  ]);
});

test("lost start reply requires lookup of the same persisted attempt", async () => {
  let starts = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method === "POST") {
        starts++;

        return Response.json({ broken: true });
      }

      return Response.json({ kind: starts === 0 ? "none" : "started" });
    },
  });

  try {
    const provider = new SandboxProvider({
      url: new URL(server.url.origin),
      token: "synthetic",
      workspace: "alpha",
      artifacts: { getBundle: () => Effect.succeed(btoa("fixture bundle")) },
    });

    const failed = await Effect.runPromiseExit(
      provider.start(key("lost-start"), 1, {
        kind: "code",
        bundleHash: "a".repeat(64),
        input: {},
        timeoutMs: 1000,
      }),
    );

    expect(providerFailure(failed)).toMatchObject([
      { _tag: "DurableProviderError", reason: "protocol", operation: "start" },
    ]);
    expect(await Effect.runPromise(provider.lookup(key("lost-start"), 1))).toEqual({
      kind: "started",
    });
    expect(starts).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("bounded stream cleanup retains typed limits and transport failures", async () => {
  let canceled = false;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(3));
    },
    cancel() {
      canceled = true;
    },
  });

  const oversized = await Effect.runPromiseExit(readBoundedText(new Response(stream), 2));
  expect(Exit.isFailure(oversized)).toBe(true);
  expect(canceled).toBe(true);
  expect(stream.locked).toBe(false);

  if (Exit.isFailure(oversized)) {
    expect(oversized.cause.reasons.filter(Cause.isFailReason)[0]?.error).toMatchObject({
      _tag: "BodyLimitError",
      limit: 2,
    });
  }

  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error("transport failed");
    },
  });

  const failure = await Effect.runPromiseExit(readBoundedBody(broken, 10));

  expect(Exit.isFailure(failure)).toBe(true);

  if (Exit.isFailure(failure)) {
    expect(failure.cause.reasons.filter(Cause.isFailReason)[0]?.error).toMatchObject({
      _tag: "BodyReadError",
      operation: "read body",
    });
  }

  expect(broken.locked).toBe(false);
});

test("a limit failure keeps a rejected cancellation in its cause", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(CLOUD_MAX_REQUEST_BYTES + 1));
    },
    cancel() {
      return Promise.reject(new Error("cancel rejected"));
    },
  });

  const exit = await Effect.runPromiseExit(readBoundedBody(stream, CLOUD_MAX_REQUEST_BYTES));

  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit)) {
    const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
    expect(errors).toContainEqual(expect.objectContaining({ _tag: "BodyLimitError" }));
    expect(errors).toContainEqual(
      expect.objectContaining({ _tag: "BodyReadError", operation: "cancel body" }),
    );
  }

  expect(stream.locked).toBe(false);
});

test("interrupted reads bound stalled cancellation and release the reader lock", async () => {
  let entered: () => void = () => {};

  const pulling = new Promise<void>((resolve) => {
    entered = resolve;
  });

  let canceled = false;

  const stream = new ReadableStream<Uint8Array>({
    pull() {
      entered();

      return new Promise(() => {});
    },
    cancel() {
      canceled = true;

      return new Promise(() => {});
    },
  });

  const abort = new AbortController();

  const result = Effect.runPromiseExit(readBoundedText(new Response(stream), 10), {
    signal: abort.signal,
  });

  await pulling;
  abort.abort();
  const exit = await result;
  expect(canceled).toBe(true);
  expect(stream.locked).toBe(false);
  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(
      exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
    ).toContainEqual(expect.objectContaining({ _tag: "BodyReadError", operation: "cancel body" }));
  }
}, 3000);

test("an oversized attempt request is the sandbox's coded 413, not a protocol fault", async () => {
  const fixture = await authorityFixture();
  const bundle = "A".repeat(Math.ceil(SANDBOX_MAX_BUNDLE_BYTES / 3) * 4);
  // The largest bundle plus a large input passes every per-field bound but not the request cap.
  const input = { text: "x".repeat(SANDBOX_MAX_REQUEST_BYTES - bundle.length + 1) };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* startSandbox(fixture.config, () =>
          Effect.succeed({
            authority: fixture.authority,
            resultsFor: fixture.resultsFor,
            artifactReader,
            backend: {
              start: () => Effect.succeed(successful),
              recover: () => Effect.succeed(uncertain),
            },
            close: () => fixture.authority.close(),
          }),
        );

        const provider = new SandboxProvider({
          url: new URL(service.server.url.origin),
          token: fixture.config.token,
          workspace: "alpha",
          artifacts: { getBundle: () => Effect.succeed(bundle) },
        });

        const exit = yield* Effect.exit(
          provider.start(key("oversized"), 1, {
            kind: "code",
            bundleHash: "a".repeat(64),
            input,
            timeoutMs: 1000,
          }),
        );

        const [error] = providerFailure(exit);
        expect(error).toMatchObject({
          _tag: "DurableProviderError",
          operation: "start",
          reason: "transport",
          cause: { cause: expect.stringContaining("(too_large)") },
        });
      }),
    ),
  );
});
