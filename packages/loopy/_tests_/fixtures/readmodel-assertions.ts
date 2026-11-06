import { expect } from "bun:test";
import type { Effect } from "effect";
import {
  emptyRunCounts,
  type RunStatus,
  type ScopeItem,
  type ScopeItemsQuery,
  type Store,
} from "../../src/core";
import type { countHistory } from "./readmodel-history";

export function checkCountHistory(
  history: Awaited<ReturnType<typeof countHistory>>,
  rollbackError: string,
) {
  const expected: Partial<Record<RunStatus, number>>[] = [
    {},
    { queued: 7 },
    { queued: 6, running: 1 },
    { queued: 6, suspended: 1 },
    { queued: 6, succeeded: 1 },
    { queued: 5, succeeded: 1, suspended: 1 },
    { queued: 3, succeeded: 1, suspended: 1, failed: 1, cancelled: 1 },
    { queued: 2, running: 1, succeeded: 1, suspended: 1, failed: 1, cancelled: 1 },
  ];

  expect(history.snapshots.map(({ stage }) => stage)).toEqual([
    "empty",
    "create",
    "claim",
    "release",
    "finish",
    "suspend",
    "terminal",
    "rollback",
  ]);

  for (const [index, snapshot] of history.snapshots.entries()) {
    const total = emptyRunCounts();
    const global = emptyRunCounts();

    const keys = snapshot.rows.map(({ workspace, slug, status }) =>
      JSON.stringify([workspace, slug, status]),
    );

    expect(new Set(keys).size).toBe(keys.length);

    for (const row of snapshot.rows) {
      total[row.status] += row.count;
      expect(row.count).toBeGreaterThan(0);

      if (row.slug === "shared") {
        global[row.status] += row.count;
      }
    }

    expect(total).toEqual({ ...emptyRunCounts(), ...expected[index] });
    expect(global).toEqual(snapshot.global);

    for (const filter of snapshot.filters) {
      const counts = emptyRunCounts();

      for (const row of snapshot.rows) {
        if (row.workspace === filter.workspace && row.slug === filter.slug) {
          counts[row.status] += row.count;
        }
      }

      expect(counts).toEqual(filter.counts);
    }
  }

  expect(history.error).toBe(rollbackError);
  expect(history.after).toEqual(history.before);
}

export async function checkScopePages(
  read: (query: ScopeItemsQuery) => Promise<Effect.Success<ReturnType<Store["scopeItems"]>>>,
) {
  for (const limit of [97, 98, 200]) {
    const terminal = await read({
      nodeId: "map",
      parentScope: "[]",
      limit,
      after: (213 - limit) * 2 - 1,
    });

    expect(terminal.items).toHaveLength(limit);
    expect(terminal.next).toBeNull();

    for (const status of [undefined, "waiting"] as const) {
      const seen: number[] = [];
      let after: number | null = null;
      let pages = 0;

      do {
        const query: ScopeItemsQuery = { nodeId: "map", parentScope: "[]", limit };

        if (status) {
          query.status = status;
        }

        if (after !== null) {
          query.after = after;
        }

        const page = await read(query);
        expect(page.items.length).toBeLessThanOrEqual(limit);

        for (const item of page.items) {
          const ordinal = item.index / 2;
          const counts: ScopeItem["counts"] = { succeeded: 1 };

          if (ordinal % 10 !== 0) {
            counts.waiting = 1;
          }

          if (ordinal % 3 === 0) {
            counts.failed = 1;
          }

          expect(item.counts).toEqual(counts);
          expect(item.index).toBeGreaterThan(after ?? -1);
        }

        seen.push(...page.items.map(({ index }) => index));
        expect(page.next).toBe(
          page.items.length === limit ? (page.items.at(-1)?.index ?? null) : null,
        );
        after = page.next;
        pages++;
        expect(pages).toBeLessThanOrEqual(4);
      } while (after !== null);

      expect(seen).toEqual(
        Array.from(Array(213).keys())
          .filter((index) => status === undefined || index % 10 !== 0)
          .map((index) => index * 2),
      );
      expect(new Set(seen).size).toBe(seen.length);
      expect(await read({ nodeId: "map", parentScope: "[]", limit, after: 424 })).toEqual({
        items: [],
        next: null,
      });
    }
  }
}
