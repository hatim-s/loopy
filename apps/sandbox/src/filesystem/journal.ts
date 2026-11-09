import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import {
  type AttemptRecord,
  AuthorityError,
  artifactHelperName,
  attemptRecordSchema,
  type DockerAttemptPlan,
  type ExportRecord,
  exportRecordSchema,
  planMatches,
} from "@loopy/contract/sandbox";
import { Effect, Result } from "effect";
import { readBytes } from "../journal-files";
import { checked, failure, io } from "../operations";
import { stateLayout } from "../state-root";
import { legacyRecord } from "./legacy";

export class FilesystemJournal {
  private readonly layout: ReturnType<typeof stateLayout>;
  constructor(private readonly root: string) {
    this.layout = stateLayout(root);
  }
  validPlan(plan: DockerAttemptPlan) {
    return Effect.promise(() => planMatches(this.root, plan));
  }

  read(id: string) {
    return Effect.gen({ self: this }, function* () {
      if (!/^[a-f0-9]{64}$/.test(id)) {
        return yield* Effect.fail(new AuthorityError("invalid_state"));
      }

      const bytes = yield* io("filesystem-journal", () => readBytes(this.receiptPath(id)));

      if (!bytes) {
        return null;
      }

      const value = yield* checked("receipt JSON", () => JSON.parse(bytes.toString("utf8")));

      const decoded = yield* checked("receipt decode", () =>
        decodeBoundary(attemptRecordSchema)(value),
      ).pipe(Effect.result);

      const record = Result.isSuccess(decoded)
        ? decoded.success
        : yield* checked("retained receipt decode", () => legacyRecord(value));

      if (record.plan.id !== id || !(yield* this.validPlan(record.plan))) {
        return yield* Effect.fail(
          failure(
            "filesystem-journal",
            new Error("Sandbox receipt identity does not match its configured root."),
          ),
        );
      }

      return record;
    }).pipe(Effect.uninterruptible);
  }

  records() {
    return Effect.gen({ self: this }, function* () {
      const result: AttemptRecord[] = [];

      for (const name of yield* io("filesystem-journal", () => readdir(this.layout.receipts))) {
        if (/^[a-f0-9]{64}\.json$/.test(name)) {
          const record = yield* this.read(name.slice(0, -5));

          if (record) {
            result.push(record);
          }
        }
      }

      return result;
    }).pipe(Effect.uninterruptible);
  }

  receiptPath(id: string) {
    return join(this.layout.receipts, `${id}.json`);
  }

  guardPath(attemptId: string) {
    return join(this.layout.exports, `${attemptId}.json`);
  }

  releasedPath(token: string) {
    return join(
      this.layout.exports,
      `${createHash("sha256").update(token).digest("hex")}.released.json`,
    );
  }

  released(token: string) {
    return Effect.gen({ self: this }, function* () {
      const bytes = yield* io("filesystem-journal", () => readBytes(this.releasedPath(token)));

      if (!bytes) {
        return null;
      }

      const record = yield* checked("export decode", () =>
        decodeBoundary(exportRecordSchema)(JSON.parse(bytes.toString("utf8"))),
      );

      if (record.token !== token) {
        return yield* Effect.fail(
          failure(
            "filesystem-journal",
            new Error("Released export token does not match its path."),
          ),
        );
      }

      return record;
    }).pipe(Effect.uninterruptible);
  }

  exportMetadata() {
    return Effect.gen({ self: this }, function* () {
      const result: ExportRecord[] = [];

      for (const name of yield* io("filesystem-journal", () => readdir(this.layout.exports))) {
        if (/^[a-f0-9]{64}\.json$/.test(name)) {
          const bytes = yield* io("filesystem-journal", () =>
            readBytes(join(this.layout.exports, name)),
          );

          if (bytes) {
            const record = yield* checked("export decode", () =>
              decodeBoundary(exportRecordSchema)(JSON.parse(bytes.toString("utf8"))),
            );

            if (
              `${record.attemptId}.json` !== name ||
              record.helper !== artifactHelperName(record.attemptId)
            ) {
              return yield* Effect.fail(
                failure(
                  "filesystem-journal",
                  new Error("Sandbox export guard identity does not match its path."),
                ),
              );
            }

            result.push(record);
          }
        }
      }

      return result;
    }).pipe(Effect.uninterruptible);
  }

  guards() {
    return Effect.gen({ self: this }, function* () {
      const guards = yield* this.exportMetadata();

      for (const record of guards) {
        const attempt = yield* this.read(record.attemptId);

        if (!attempt || attempt.plan.volume !== record.volume) {
          return yield* Effect.fail(
            failure(
              "filesystem-journal",
              new Error("Sandbox export guard does not match its admitted workspace."),
            ),
          );
        }
      }

      return guards;
    }).pipe(Effect.uninterruptible);
  }
}
