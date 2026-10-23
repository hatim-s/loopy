import type { Store } from "../../src/core/index.js";

export const readmodelAt = "2026-10-23T00:00:00.000Z";

export async function countHistory(store: Store) {
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
    const rows = await store.runCountsByDefinition();

    const filters = await Promise.all(
      identities.map(async (identity) => ({
        ...identity,
        counts: await store.runCounts(identity),
      })),
    );

    return { stage, rows, filters, global: await store.runCounts({ slug: "shared" }) };
  }

  snapshots.push(await snapshot("empty"));

  for (const [index, identity] of identities.entries()) {
    await store.createRun({
      ...identity,
      id: `count-${index}`,
      revision: "synthetic-revision",
      status: "queued",
      input: { retained: index },
      createdAt: readmodelAt,
      updatedAt: readmodelAt,
    });
  }

  snapshots.push(await snapshot("create"));
  await store.claim("count-0", "owner");
  snapshots.push(await snapshot("claim"));
  await store.release("count-0", "owner");
  snapshots.push(await snapshot("release"));
  await store.claim("count-0", "owner");
  await store.finishRun("count-0", "owner", { status: "succeeded", output: { kept: true } });
  snapshots.push(await snapshot("finish"));
  await store.claim("count-1", "owner");
  await store.suspend("count-1", "owner", "2026-10-23T01:00:00.000Z");
  snapshots.push(await snapshot("suspend"));
  await store.claim("count-2", "owner");
  await store.finishRun("count-2", "owner", { status: "failed", error: "controlled failure" });
  await store.claim("count-3", "owner");
  await store.apply({
    runId: "count-3",
    token: "owner",
    effects: [{ kind: "finish_run", outcome: { status: "cancelled" }, at: readmodelAt }],
  });
  snapshots.push(await snapshot("terminal"));
  await store.claim("count-4", "owner");
  const before = await store.eventCursor();
  let error: string | null = null;

  try {
    await store.apply({
      runId: "count-4",
      token: "owner",
      effects: [
        { kind: "finish_run", outcome: { status: "succeeded", output: null }, at: readmodelAt },
        { kind: "schedule_retry", at: "invalid-timestamp" },
      ],
    });
  } catch (cause) {
    if (!(cause instanceof Error)) {
      throw new Error("Unexpected non-error rollback failure.", { cause });
    }

    error = cause.message;
  }

  snapshots.push(await snapshot("rollback"));

  return { snapshots, error, before, after: await store.eventCursor() };
}
