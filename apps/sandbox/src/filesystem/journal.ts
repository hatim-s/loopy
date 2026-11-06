import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type AttemptRecord,
  AuthorityError,
  artifactHelperName,
  attemptRecordSchema,
  attemptResourceNames,
  type DockerAttemptPlan,
  decodeBoundary,
  type ExportRecord,
  exportRecordSchema,
  workspaceVolumeInput,
} from "@loopy/contract";
import { Effect, Result } from "effect";
import { attemptHash, attemptId } from "../admission";
import { readBytes } from "../journal-files";
import { checked, failure, io } from "../operations";
import { storedReceiptSchema } from "../receipts";

export class FilesystemJournal {
  constructor(private readonly root: string) {}
  validPlan(plan: DockerAttemptPlan) {
    const names = attemptResourceNames(plan.id, attemptHash(workspaceVolumeInput(this.root, plan)));

    return (
      plan.id === attemptId(this.root, plan) &&
      plan.container === names.container &&
      plan.inputVolume === names.inputVolume &&
      plan.volume === names.volume
    );
  }

  read(id: string) {
    return Effect.gen({ self: this }, function* () {
      if (!/^[a-f0-9]{64}$/.test(id)) {
        return yield* Effect.fail(new AuthorityError("invalid_state"));
      }

      const bytes = yield* io("filesystem-journal", () =>
        readBytes(join(this.root, "receipts", `${id}.json`)),
      );

      if (!bytes) {
        return null;
      }

      const value = yield* checked("receipt JSON", () => JSON.parse(bytes.toString("utf8")));
      let record: AttemptRecord;

      const decoded = yield* checked("receipt decode", () =>
        decodeBoundary(attemptRecordSchema)(value),
      ).pipe(Effect.result);

      if (Result.isSuccess(decoded)) {
        record = decoded.success;
      } else {
        const legacy = yield* checked("retained receipt decode", () =>
          decodeBoundary(storedReceiptSchema)(value),
        );

        const { kind, ...fields } = legacy;

        const plan = {
          id: fields.id,
          requestHash: fields.requestHash,
          workspace: fields.workspace,
          executionKey: fields.executionKey,
          attempt: fields.attempt,
          container: fields.container,
          inputVolume: fields.inputVolume,
          volume: fields.volume,
          deadline: fields.deadline,
        };

        const session = { epoch: 1, nonce: "legacy-filesystem-recovery" };
        record =
          kind === "started"
            ? { kind, plan, session }
            : { kind, plan, session, result: { kind: "inline", value: legacy.result } };
      }

      if (record.plan.id !== id || !this.validPlan(record.plan)) {
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

      for (const name of yield* io("filesystem-journal", () =>
        readdir(join(this.root, "receipts")),
      )) {
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

  releasedPath(token: string) {
    return join(
      this.root,
      "exports",
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

      for (const name of yield* io("filesystem-journal", () =>
        readdir(join(this.root, "exports")),
      )) {
        if (/^[a-f0-9]{64}\.json$/.test(name)) {
          const bytes = yield* io("filesystem-journal", () =>
            readBytes(join(this.root, "exports", name)),
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
