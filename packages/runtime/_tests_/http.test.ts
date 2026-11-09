import { expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { readBoundedBody } from "../src/http";

const LIMIT = 1024;

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

  const oversized = await Effect.runPromiseExit(readBoundedBody(stream, 2));
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
      controller.enqueue(new Uint8Array(LIMIT + 1));
    },
    cancel() {
      return Promise.reject(new Error("cancel rejected"));
    },
  });

  const exit = await Effect.runPromiseExit(readBoundedBody(stream, LIMIT));

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

  const result = Effect.runPromiseExit(readBoundedBody(stream, 10), {
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
