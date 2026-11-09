import { Data, Effect } from "effect";
import { FilesystemAuthority } from "../../sandbox/src/filesystem/authority";
import { FilesystemResults } from "../../sandbox/src/filesystem/results";
import { resolveResult } from "../../sandbox/src/receipt-view";

class FixtureReceiptMissing extends Data.TaggedError("FixtureReceiptMissing")<{ id: string }> {
  override get message() {
    return `Fixture receipt ${this.id} is missing.`;
  }
}

/** Read retained fixture state without opening a writer session or changing its format. */
export function filesystemReceipt(root: string, id: string) {
  return Effect.gen(function* () {
    const record = yield* new FilesystemAuthority(root).read({ id });

    if (!record) {
      return yield* new FixtureReceiptMissing({ id });
    }

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
