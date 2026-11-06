import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import { executionKeySchema, sandboxExecutionResultSchema } from "../contract";
import {
  type ExecutionKey,
  type ExecutionResult,
  ExecutorError,
  errnoCode,
  executionKeyString,
} from "../core";

export const filesystemReceiptsDescriptorSchema = Schema.Struct({
  kind: Schema.Literal("filesystem"),
  home: Schema.NonEmptyString,
});

export type FilesystemReceiptsDescriptor = typeof filesystemReceiptsDescriptorSchema.Type;

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
    result: sandboxExecutionResultSchema,
  }),
]);

export type LocalReceipt = typeof receiptSchema.Type;

export type AttemptIdentity = Pick<LocalReceipt, "executionKey" | "attempt">;

export type FinishedLocalReceipt = Extract<LocalReceipt, { kind: "finished" }>;

const io = <A>(body: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: body,
    catch: (cause) => new ExecutorError({ operation: "receipt", cause }),
  });

const rejected = (message: string) =>
  Effect.fail(new ExecutorError({ operation: "receipt", cause: new Error(message) }));

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

function syncDirectory(path: string) {
  return Effect.acquireUseRelease(
    io(() => open(dirname(path), "r")),
    (file) => io(() => file.sync()),
    (file) => io(() => file.close()),
  );
}

function writeExclusive(path: string, value: LocalReceipt) {
  return Effect.acquireUseRelease(
    io(() => open(path, "wx", 0o600)),
    (file) =>
      Effect.gen(function* () {
        yield* io(() => file.writeFile(JSON.stringify(value)));
        yield* io(() => file.sync());
      }),
    (file) => io(() => file.close()),
  );
}

/** Only the claiming child finishes live work. A parent confirms death and rereads first. */
export class FilesystemReceipts {
  constructor(private readonly home: string) {}
  get descriptor(): FilesystemReceiptsDescriptor {
    return { kind: "filesystem", home: this.home };
  }

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
      try: () => Schema.decodeUnknownSync(receiptSchema)(JSON.parse(text)),
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

    // Publish complete bytes with an exclusive link. Readers must never see a partial claim.
    return yield* Effect.uninterruptible(
      Effect.gen({ self: this }, function* () {
        const created = yield* Effect.acquireUseRelease(
          io(() => mkdtemp(`${path}.claim-`)),
          (directory) =>
            Effect.gen(function* () {
              const temporary = join(directory, "started.json");
              yield* writeExclusive(temporary, { ...identity, kind: "started", pid: process.pid });

              const linked = yield* io(() => link(temporary, path)).pipe(
                Effect.as(true),
                Effect.catchIf(
                  (error) => errnoCode(error.cause) === "EEXIST",
                  () => Effect.succeed(false),
                ),
              );

              if (linked) {
                yield* syncDirectory(path);
              }

              return linked;
            }),
          (directory) => io(() => rm(directory, { recursive: true, force: true })),
        );

        if (created) {
          return { kind: "created" as const };
        }

        const receipt = yield* this.read(identity);

        if (!receipt) {
          return yield* rejected(
            "Claimed receipt disappeared. Inspect the daemon home before retrying.",
          );
        }

        return { kind: "existing" as const, receipt };
      }),
    );
  });

  private observeClaim = Effect.fn(function* (
    this: FilesystemReceipts,
    receipt: Extract<LocalReceipt, { kind: "started" }>,
  ) {
    const dead = yield* Effect.try({
      try: () => {
        process.kill(receipt.pid, 0);

        return false;
      },
      catch: (cause) => new ExecutorError({ operation: "receipt", cause }),
    }).pipe(
      Effect.catchIf(
        (error) => errnoCode(error.cause) === "ESRCH",
        () => Effect.succeed(true),
      ),
    );

    if (!dead) {
      return { kind: "started" as const };
    }

    const latest = yield* this.read(receipt);

    return latest?.kind === "finished" ? latest : { kind: "dead" as const };
  });

  private publish = Effect.fn(function* (this: FilesystemReceipts, value: FinishedLocalReceipt) {
    const path = yield* receiptPath(this.home, value.executionKey, value.attempt);

    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const temporary = `${path}.${process.pid}.tmp`;
        yield* writeExclusive(temporary, value);
        yield* io(() => rename(temporary, path));
        yield* syncDirectory(path);

        return value;
      }),
    );
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
