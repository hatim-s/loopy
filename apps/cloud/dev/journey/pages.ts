import { type ExecutionPage, PAGE_LIMIT, routes } from "@loopy/contract";
import { Effect } from "effect";
import { assert, equal } from "../shared/assert";
import { compileFixture } from "../shared/compile-fixture";
import type { Journey } from "./client";

export async function pages(journey: Journey, runId: string) {
  const query = { slug: "cloud-journey-execution", workspace: "fixtures", limit: 1 };
  const first = await journey.call(routes.runs, { query });
  equal(first.runs.length, 1, "run_page_not_bounded");
  assert(first.runs[0] && first.next, "missing_run_page");

  const second = await journey.call(routes.runs, { query: { ...query, before: first.next } });

  equal(second.runs.length, 1, "second_run_page_missing");
  assert(second.runs[0]?.id !== first.runs[0].id, "run_page_repeats_cursor");
  const nodeIds = new Set<string>();
  let after: string | null = null;
  let nodePages = 0;

  do {
    const page: ExecutionPage = await journey.call(routes.executions, {
      params: { id: runId },
      query: { limit: 2, after: after ?? undefined },
    });

    assert(page.items.length <= 2 && page.items.length > 0, "execution_page_not_bounded");

    for (const node of page.items) {
      const key = JSON.stringify(node.key);
      assert(!nodeIds.has(key), "execution_page_duplicate");
      nodeIds.add(key);
    }

    assert(page.next === null || page.next !== after, "execution_cursor_stalled");
    after = page.next;
    nodePages += 1;
    assert(nodePages <= 50, "execution_pagination_did_not_end");
  } while (after !== null);

  assert(nodePages > 1, "execution_pagination_not_exercised");

  const logs = await journey.call(routes.logs, { params: { id: runId }, query: { limit: 2 } });
  equal(logs.length, 2, "run_log_page_not_bounded");

  const moreLogs = await journey.call(routes.logs, {
    params: { id: runId },
    query: { limit: 2, after: logs.at(-1)?.seq },
  });

  assert(moreLogs.length > 0 && moreLogs.length <= 2, "run_log_cursor_missing");
  assert(
    moreLogs.every((log) => log.seq > (logs.at(-1)?.seq ?? 0)),
    "run_logs_replayed_cursor",
  );

  const global = await journey.call(routes.globalLogs, { query: { runId, limit: 2 } });
  equal(global.items.length, 2, "global_log_page_not_bounded");
  assert(global.hasMore && global.next !== null, "global_log_cursor_missing");

  const globalNext = await journey.call(routes.globalLogs, {
    query: { runId, limit: 2, before: global.next ?? undefined },
  });

  assert(
    globalNext.items.length > 0 && globalNext.items.length <= 2,
    "global_log_second_page_missing",
  );
  assert(
    globalNext.items.every((item) => !global.items.some((previous) => previous.id === item.id)),
    "global_log_page_duplicates",
  );

  const feed = await journey.call(routes.eventHistory, { query: { runId, limit: 2 } });

  equal(feed.items.length, 2, "event_feed_not_bounded");
  assert(feed.hasMore && feed.next !== null, "event_feed_cursor_missing");

  const feedNext = await journey.call(routes.eventHistory, {
    query: { runId, limit: 2, before: feed.next ?? undefined },
  });

  assert(feedNext.items.length > 0 && feedNext.items.length <= 2, "event_feed_second_page_missing");
  assert(
    feedNext.items.every(
      (item) => !feed.items.some((previous) => previous.sequence === item.sequence),
    ),
    "event_feed_page_duplicates",
  );

  const oversized = { limit: PAGE_LIMIT + 1 };
  const run = { id: runId };

  for (const sent of [
    () => journey.send(routes.runs, { query: oversized }),
    () => journey.send(routes.executions, { params: run, query: oversized }),
    () => journey.send(routes.logs, { params: run, query: oversized }),
    () => journey.send(routes.globalLogs, { query: oversized }),
    () => journey.send(routes.eventHistory, { query: oversized }),
  ]) {
    await journey.denied(sent(), 400, "bad_request");
  }

  return {
    runPages: 2,
    nodePages,
    rootNodes: nodeIds.size,
    logPages: 2,
    feedPages: 2,
    oversizedLimitsDenied: 5,
  };
}

export async function isolation(journey: Journey, runId: string) {
  const other = { query: { workspace: "other" } };

  const queries = [
    () => journey.send(routes.runs, other),
    () => journey.send(routes.loopies, other),
    () => journey.send(routes.globalLogs, other),
    () => journey.send(routes.eventHistory, other),
    () => journey.send(routes.schedules, other),
  ];

  for (const sent of queries) {
    await journey.denied(sent(), 403, "forbidden");
  }

  await journey.denied(
    journey.send(routes.startRun, {
      params: { slug: "cloud-journey-execution" },
      body: { input: { name: "fixture", chooseYes: true, items: [] }, workspace: "other" },
    }),
    403,
    "forbidden",
  );
  const compiled = await Effect.runPromise(compileFixture("execution.ts"));
  await journey.denied(
    journey.send(routes.putLoopy, {
      params: { slug: compiled.graph.name },
      body: { ...compiled, source: { ...compiled.source, workspace: "other" } },
    }),
    403,
    "forbidden",
  );

  const params = { params: { id: runId } };
  const asOther = { principal: "other" } as const;

  const runResources = [
    () => journey.send(routes.run, params, asOther),
    () => journey.send(routes.runGraph, params, asOther),
    () => journey.send(routes.runSource, params, asOther),
    () => journey.send(routes.runPayload, params, asOther),
    () => journey.send(routes.logs, params, asOther),
    () => journey.send(routes.executions, params, asOther),
  ];

  for (const sent of runResources) {
    await journey.denied(sent(), 404, "not_found");
  }

  const otherRuns = await journey.call(routes.runs, { query: { limit: 200 } }, asOther);

  assert(
    otherRuns.runs.every((run) => run.workspace === "other" && run.id !== runId),
    "other_workspace_leaked_run",
  );

  const otherFeed = await journey.call(
    routes.eventHistory,
    { query: { runId, limit: 2 } },
    asOther,
  );

  equal(otherFeed.items.length, 0, "other_workspace_leaked_feed");

  return {
    queryDenials: queries.length,
    bodyDenials: 2,
    runResourceDenials: runResources.length,
    filteredOtherFeedEmpty: true,
  };
}
