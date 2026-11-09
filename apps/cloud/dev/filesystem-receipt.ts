import type { AttemptRecord } from "@loopy/contract/sandbox";
import { Data, Effect } from "effect";
import { FilesystemJournal } from "../../sandbox/src/filesystem/journal";
import { FilesystemResults } from "../../sandbox/src/filesystem/results";
import { resolveResult } from "../../sandbox/src/receipt-view";
import { stateLayout } from "../../sandbox/src/state-root";
import { lstatOrAbsent } from "./shared/fs";

class FixtureReceiptMissing extends Data.TaggedError("FixtureReceiptMissing")<{ id: string }> {
  override get message() {
    return `Fixture receipt ${this.id} is missing.`;
  }
}

function receiptView(root: string, record: AttemptRecord) {
  return Effect.gen(function* () {
    if (record.kind === "started") {
      return { ...record.plan, kind: "started" as const };
    }

    const result = yield* resolveResult(
      (workspace) => new FilesystemResults(root, workspace),
      record,
    );

    return { ...record.plan, kind: "finished" as const, result };
  });
}

// These read retained fixture state through the journal without opening a writer session.

export function filesystemReceipt(root: string, id: string) {
  return Effect.gen(function* () {
    const record = yield* new FilesystemJournal(root).read(id);

    if (!record) {
      return yield* new FixtureReceiptMissing({ id });
    }

    return yield* receiptView(root, record);
  });
}

export async function filesystemReceipts(root: string) {
  // A stack that stopped before its sandbox wrote any state owns no receipts.
  if (!(await lstatOrAbsent(stateLayout(root).receipts))) {
    return [];
  }

  return Effect.runPromise(
    new FilesystemJournal(root)
      .records()
      .pipe(
        Effect.flatMap((records) => Effect.forEach(records, (record) => receiptView(root, record))),
      ),
  );
}

export type StoredReceipt = Effect.Success<ReturnType<typeof filesystemReceipt>>;
