import { type DashboardReader, emptyRunCounts } from "@loopy/contract";
import type { RunOutcome, RunRecord, Store } from "@loopy/core";
import { Effect } from "effect";

export const readmodelAt = "2026-10-23T00:00:00.000Z";

export async function countHistory(store: Store & DashboardReader) {
  const finish = (runId: string, outcome: RunOutcome) =>
    Effect.runPromise(
      store.apply({
        runId,
        token: "owner",
        effects: [{ kind: "finish_run", outcome, at: readmodelAt }],
      }),
    );

  const snapshots: Awaited<ReturnType<typeof snapshot>>[] = [];

  const identities = [
    { workspace: "alpha", slug: "shared" },
    { workspace: "alpha", slug: "shared" },
    { workspace: "bravo", slug: "shared" },
    { workspace: "bravo", slug: "shared" },
    { workspace: "alpha", slug: "other" },
    { workspace: "a|b", slug: "c" },
    { workspace: "a", slug: "b|c" },
  ];

  async function snapshot(stage: string) {
    const rows = await Effect.runPromise(store.runCountsByDefinition());
    const runs: RunRecord[] = [];
    let before: string | undefined;

    while (true) {
      const page = await Effect.runPromise(store.queryRuns({ now: readmodelAt, limit: 2, before }));
      runs.push(...page);
      const last = page.at(-1);

      if (!last) {
        break;
      }

      before = `${last.createdAt}|${last.id}`;
    }

    const filters = identities.map((identity) => {
      const counts = emptyRunCounts();

      for (const run of runs) {
        if (run.workspace === identity.workspace && run.slug === identity.slug) {
          counts[run.status]++;
        }
      }

      return { ...identity, counts };
    });

    const global = emptyRunCounts();

    for (const run of runs) {
      if (run.slug === "shared") {
        global[run.status]++;
      }
    }

    return { stage, rows, filters, global };
  }

  snapshots.push(await snapshot("empty"));

  for (const [index, identity] of identities.entries()) {
    await Effect.runPromise(
      store.createRun({
        ...identity,
        id: `count-${index}`,
        revision: "synthetic-revision",
        status: "queued",
        input: { retained: index },
        createdAt: readmodelAt,
        updatedAt: readmodelAt,
      }),
    );
  }

  snapshots.push(await snapshot("create"));
  await Effect.runPromise(store.claim("count-0", "owner"));
  snapshots.push(await snapshot("claim"));
  await Effect.runPromise(store.release("count-0", "owner"));
  snapshots.push(await snapshot("release"));
  await Effect.runPromise(store.claim("count-0", "owner"));
  await finish("count-0", { status: "succeeded", output: { kept: true } });
  snapshots.push(await snapshot("finish"));
  await Effect.runPromise(store.claim("count-1", "owner"));
  await Effect.runPromise(
    store.apply({
      runId: "count-1",
      token: "owner",
      effects: [{ kind: "suspend_run", wakeAt: "2026-10-23T01:00:00.000Z", at: readmodelAt }],
    }),
  );
  snapshots.push(await snapshot("suspend"));
  await Effect.runPromise(store.claim("count-2", "owner"));
  await finish("count-2", { status: "failed", error: "controlled failure" });
  await Effect.runPromise(store.claim("count-3", "owner"));
  await finish("count-3", { status: "cancelled" });
  snapshots.push(await snapshot("terminal"));
  await Effect.runPromise(store.claim("count-4", "owner"));
  const before = await Effect.runPromise(store.eventCursor());
  let error: string | null = null;

  try {
    await Effect.runPromise(
      store.apply({
        runId: "count-4",
        token: "owner",
        effects: [
          { kind: "finish_run", outcome: { status: "succeeded", output: null }, at: readmodelAt },
          { kind: "schedule_retry", at: "invalid-timestamp" },
        ],
      }),
    );
  } catch (cause) {
    if (!(cause instanceof Error)) {
      throw new Error("Unexpected non-error rollback failure.", { cause });
    }

    error = cause.message;
  }

  snapshots.push(await snapshot("rollback"));

  return { snapshots, error, before, after: await Effect.runPromise(store.eventCursor()) };
}
