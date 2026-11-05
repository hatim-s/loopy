import { Effect } from "effect";
import { FilesystemAuthority } from "../../apps/sandbox/src/filesystem-authority.js";
import { FilesystemResults } from "../../apps/sandbox/src/immutable-results.js";

/** Read retained fixture state without opening a writer session or changing its format. */
export function filesystemReceipt(root: string, id: string) {
  return Effect.gen(function* () {
    const record = yield* new FilesystemAuthority(root).read(id);

    if (!record) {
      return yield* Effect.fail(new Error(`Fixture receipt ${id} is missing.`));
    }

    if (record.kind === "started") {
      return { ...record.plan, kind: "started" as const };
    }

    const result =
      record.result.kind === "inline"
        ? record.result.value
        : yield* new FilesystemResults(root, record.plan.workspace).get(record.result.ref);

    return { ...record.plan, kind: "finished" as const, result };
  });
}
