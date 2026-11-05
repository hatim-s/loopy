import { Effect } from "effect";
import { type ExecutionPage, routes } from "../../packages/loopy/src/contract/index.js";
import { assert, equal, type Journey } from "./journey-client.js";

export async function pages(journey: Journey, runId: string) {
  const query = `slug=cloud-journey-execution&workspace=fixtures&limit=1`;
  const first = await journey.json(routes.runs.response, `/runs?${query}`);
  equal(first.length, 1, "run_page_not_bounded");
  assert(first[0], "missing_run_page");
  const before = encodeURIComponent(`${first[0].createdAt}|${first[0].id}`);
  const second = await journey.json(routes.runs.response, `/runs?${query}&before=${before}`);
  equal(second.length, 1, "second_run_page_missing");
  assert(second[0]?.id !== first[0].id, "run_page_repeats_cursor");
  const nodeIds = new Set<string>();
  let after: string | null = null;
  let nodePages = 0;

  do {
    const page: ExecutionPage = await journey.json(
      routes.executions.response,
      `/runs/${runId}/executions?limit=2${after ? `&after=${encodeURIComponent(after)}` : ""}`,
    );

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

  const logs = await journey.json(routes.logs.response, `/runs/${runId}/logs?limit=2`);
  equal(logs.length, 2, "run_log_page_not_bounded");

  const moreLogs = await journey.json(
    routes.logs.response,
    `/runs/${runId}/logs?limit=2&after=${logs.at(-1)?.seq}`,
  );

  assert(moreLogs.length > 0 && moreLogs.length <= 2, "run_log_cursor_missing");
  assert(
    moreLogs.every((log) => log.seq > (logs.at(-1)?.seq ?? 0)),
    "run_logs_replayed_cursor",
  );

  const global = await journey.json(routes.globalLogs.response, `/logs?runId=${runId}&limit=2`);
  equal(global.items.length, 2, "global_log_page_not_bounded");
  assert(global.hasMore && global.next !== null, "global_log_cursor_missing");

  const globalNext = await journey.json(
    routes.globalLogs.response,
    `/logs?runId=${runId}&limit=2&before=${global.next}`,
  );

  assert(
    globalNext.items.length > 0 && globalNext.items.length <= 2,
    "global_log_second_page_missing",
  );
  assert(
    globalNext.items.every((item) => !global.items.some((previous) => previous.id === item.id)),
    "global_log_page_duplicates",
  );

  const feed = await journey.json(
    routes.eventHistory.response,
    `/event-history?runId=${runId}&limit=2`,
  );

  equal(feed.items.length, 2, "event_feed_not_bounded");
  assert(feed.hasMore && feed.next !== null, "event_feed_cursor_missing");

  const feedNext = await journey.json(
    routes.eventHistory.response,
    `/event-history?runId=${runId}&limit=2&before=${feed.next}`,
  );

  assert(feedNext.items.length > 0 && feedNext.items.length <= 2, "event_feed_second_page_missing");
  assert(
    feedNext.items.every(
      (item) => !feed.items.some((previous) => previous.sequence === item.sequence),
    ),
    "event_feed_page_duplicates",
  );

  for (const path of [
    "/runs?limit=201",
    `/runs/${runId}/executions?limit=201`,
    `/runs/${runId}/logs?limit=201`,
    "/logs?limit=201",
    "/event-history?limit=201",
  ]) {
    await journey.denied(path, 400, "bad_request");
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
  const paths = ["/runs", "/loopies", "/logs", "/event-history", "/schedules"];

  for (const path of paths) {
    await journey.denied(`${path}?workspace=other`, 403, "forbidden");
  }

  await journey.denied(`/loopies/cloud-journey-execution/runs`, 403, "forbidden", {
    method: "POST",
    body: { input: { name: "fixture", chooseYes: true, items: [] }, workspace: "other" },
  });
  const compiled = await Effect.runPromise(journey.compiled("execution.ts"));
  await journey.denied(`/loopies/${compiled.graph.name}`, 403, "forbidden", {
    method: "PUT",
    body: { ...compiled, source: { ...compiled.source, workspace: "other" } },
  });

  for (const suffix of ["", "/graph", "/source", "/payload", "/logs", "/executions"]) {
    await journey.denied(`/runs/${runId}${suffix}`, 404, "not_found", { principal: "other" });
  }

  const otherRuns = await journey.json(routes.runs.response, "/runs?limit=200", {
    principal: "other",
  });

  assert(
    otherRuns.every((run) => run.workspace === "other" && run.id !== runId),
    "other_workspace_leaked_run",
  );

  const otherFeed = await journey.json(
    routes.eventHistory.response,
    `/event-history?runId=${runId}&limit=2`,
    { principal: "other" },
  );

  equal(otherFeed.items.length, 0, "other_workspace_leaked_feed");

  return {
    queryDenials: paths.length,
    bodyDenials: 2,
    runResourceDenials: 6,
    filteredOtherFeedEmpty: true,
  };
}
