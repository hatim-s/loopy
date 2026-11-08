import { watch } from "node:fs";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeJson, executionKeySchema, executionResultSchema } from "@loopy/contract";
import {
  type ExecutionKey,
  type ExecutionResult,
  ExecutorError,
  errnoCode,
  executionKeyString,
} from "@loopy/core";
import { Effect, Schema } from "effect";
import { processAlive, publishExclusive, writeFileAtomically } from "../os";

const identity = {
  executionKey: executionKeySchema,
  attempt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
};

export const receiptSchema = Schema.Union([
  Schema.Struct({
    ...identity,
    kind: Schema.Literal("started"),
    pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    ...identity,
    kind: Schema.Literal("finished"),
    result: executionResultSchema,
  }),
]);

export type LocalReceipt = typeof receiptSchema.Type;

export type AttemptIdentity = Pick<LocalReceipt, "executionKey" | "attempt">;

export type FinishedLocalReceipt = Extract<LocalReceipt, { kind: "finished" }>;

// A worker that dies before publishing leaves no file event, so liveness is rechecked on a timer.
const LIVENESS_CHECK_MS = 1000;

const io = <A>(body: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: body,
    catch: (cause) => new ExecutorError({ operation: "receipt", cause }),
  });

const sync = <A>(body: () => A) =>
  Effect.try({ try: body, catch: (cause) => new ExecutorError({ operation: "receipt", cause }) });

const rejected = (message: string) =>
  Effect.fail(new ExecutorError({ operation: "receipt", cause: new Error(message) }));

export const alreadyStarted = () =>
  Effect.fail(
    new ExecutorError({
      operation: "execute",
      cause: new Error("Execution already started. Reconcile its receipt."),
    }),
  );

export const receiptPath = Effect.fn(function* (home: string, key: ExecutionKey, attempt: number) {
  yield* io(() => mkdir(home, { recursive: true, mode: 0o700 }));
  let directory = yield* io(() => realpath(home));

  for (const segment of [
    "receipts",
    encodeURIComponent(key.runId).replaceAll(".", "%2E"),
    encodeURIComponent(executionKeyString(key)),
  ]) {
    directory = join(directory, segment);
    const path = directory;
    yield* io(() => mkdir(path, { mode: 0o700 })).pipe(
      Effect.catchIf(
        (error) => errnoCode(error.cause) === "EEXIST",
        () => Effect.void,
      ),
    );

    if (!(yield* io(() => lstat(path))).isDirectory()) {
      return yield* rejected(
        "Receipt directories must be real directories inside the daemon home.",
      );
    }
  }

  return join(directory, `${attempt}.json`);
});

function receiptChange(directory: string) {
  return Effect.callback<void, ExecutorError>((resume) => {
    const watcher = watch(directory);
    const timer = setTimeout(() => settle(Effect.void), LIVENESS_CHECK_MS);

    function settle(effect: Effect.Effect<void, ExecutorError>) {
      watcher.close();
      clearTimeout(timer);
      resume(effect);
    }

    watcher.on("change", () => settle(Effect.void));
    watcher.on("error", (cause) =>
      settle(Effect.fail(new ExecutorError({ operation: "receipt", cause }))),
    );

    return Effect.sync(() => {
      watcher.close();
      clearTimeout(timer);
    });
  });
}

/** Only the claiming child finishes live work. A parent confirms death and rereads first. */
export class FilesystemReceipts {
  constructor(private readonly home: string) {}

  read = Effect.fn("FilesystemReceipts.read")(function* (
    this: FilesystemReceipts,
    identity: AttemptIdentity,
  ) {
    const path = yield* receiptPath(this.home, identity.executionKey, identity.attempt);

    const text = yield* io(() => readFile(path, "utf8")).pipe(
      Effect.catchIf(
        (error) => errnoCode(error.cause) === "ENOENT",
        () => Effect.succeed(null),
      ),
    );

    if (text === null) {
      return null;
    }

    const receipt = yield* Effect.try({
      try: () => decodeJson(receiptSchema)(text),
      catch: (cause) => new ExecutorError({ operation: "receipt", cause }),
    });

    if (
      executionKeyString(receipt.executionKey) !== executionKeyString(identity.executionKey) ||
      receipt.attempt !== identity.attempt
    ) {
      return yield* rejected("Receipt identity does not match this execution attempt.");
    }

    return receipt;
  });

  claim = Effect.fn("FilesystemReceipts.claim")(function* (
    this: FilesystemReceipts,
    identity: AttemptIdentity,
  ) {
    const path = yield* receiptPath(this.home, identity.executionKey, identity.attempt);
    const started: LocalReceipt = { ...identity, kind: "started", pid: process.pid };

    if (yield* sync(() => publishExclusive(path, JSON.stringify(started), 0o600))) {
      return { kind: "created" as const };
    }

    const receipt = yield* this.read(identity);

    if (!receipt) {
      return yield* rejected(
        "Claimed receipt disappeared. Inspect the daemon home before retrying.",
      );
    }

    return { kind: "existing" as const, receipt };
  });

  private observeClaim = Effect.fn(function* (
    this: FilesystemReceipts,
    receipt: Extract<LocalReceipt, { kind: "started" }>,
  ) {
    if (yield* sync(() => processAlive(receipt.pid))) {
      return { kind: "started" as const };
    }

    const latest = yield* this.read(receipt);

    return latest?.kind === "finished" ? latest : { kind: "dead" as const };
  });

  private publish = Effect.fn(function* (this: FilesystemReceipts, value: FinishedLocalReceipt) {
    const path = yield* receiptPath(this.home, value.executionKey, value.attempt);
    yield* sync(() => writeFileAtomically(path, JSON.stringify(value), 0o600));

    return value;
  });

  /** Report whether this observer sealed uncertainty or found an existing completion. */
  reconcile = Effect.fn("FilesystemReceipts.reconcile")(function* (
    this: FilesystemReceipts,
    identity: AttemptIdentity,
  ) {
    const receipt = yield* this.read(identity);

    if (!receipt) {
      return { kind: "none" as const };
    }

    const observed = receipt.kind === "started" ? yield* this.observeClaim(receipt) : receipt;

    if (observed.kind === "finished") {
      return { kind: "finished" as const, receipt: observed, source: "stored" as const };
    }

    if (observed.kind === "started") {
      return observed;
    }

    const result: ExecutionResult = {
      kind: "failed",
      error: {
        code: "uncertain",
        message:
          "Executor stopped with an unfinished receipt. Inspect the workspace before starting a new run.",
      },
      exitCode: null,
      logs: [],
    };

    const finished = yield* this.publish({ kind: "finished", ...identity, result });

    return { kind: "finished" as const, receipt: finished, source: "reconciled" as const };
  });

  /** Waits for a started attempt to finish, sealing it as uncertain if its worker dies first. */
  settle = Effect.fn("FilesystemReceipts.settle")(function* (
    this: FilesystemReceipts,
    identity: AttemptIdentity,
  ) {
    const path = yield* receiptPath(this.home, identity.executionKey, identity.attempt);

    while (true) {
      const receipt = yield* this.reconcile(identity);

      if (receipt.kind === "finished") {
        return receipt.receipt;
      }

      if (receipt.kind === "none") {
        return yield* rejected(
          "Started receipt disappeared. Inspect the daemon home before retrying.",
        );
      }

      yield* receiptChange(dirname(path));
    }
  });

  finish = Effect.fn("FilesystemReceipts.finish")(function* (
    this: FilesystemReceipts,
    value: FinishedLocalReceipt,
  ): Effect.fn.Return<FinishedLocalReceipt, ExecutorError> {
    const receipt = yield* this.read(value);

    if (receipt?.kind === "finished") {
      return receipt;
    }

    if (!receipt) {
      return yield* rejected("Execution has no claimed receipt. Claim it before performing work.");
    }

    if (receipt.pid !== process.pid) {
      const observed = yield* this.observeClaim(receipt);

      if (observed.kind === "finished") {
        return observed;
      }

      if (observed.kind === "started") {
        return yield* rejected(
          "Execution worker is still alive. Reconcile its receipt before finishing.",
        );
      }
    }

    return yield* this.publish(value);
  });
}
