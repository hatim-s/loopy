import { type CursorView, type Json, routes } from "@loopy/contract";
import { Effect } from "effect";
import { assert, equal, failureEvidence } from "../shared/assert";
import { compileFixture } from "../shared/fixture-client";
import { Journey } from "./client";
import { docker } from "./docker";
import { frame } from "./events";
import { execution } from "./execution";
import { isolation, pages } from "./pages";

async function main() {
  const journey = await Journey.open();
  const slug = "cloud-journey-execution";
  const approvalSlug = "cloud-journey-approval";
  let executionId: string | undefined;
  let approvalId: string | undefined;
  let firstRevision: string | undefined;
  let firstSource: unknown;
  let cursor: CursorView | undefined;

  await journey.evidence.check("authentication", async () => {
    await journey.denied(journey.send(routes.runs, {}, { principal: "none" }), 401, "unauthorized");
    await journey.denied(
      journey.send(routes.runs, {}, { principal: "invalid" }),
      401,
      "unauthorized",
    );
    await journey.denied(
      journey.send(routes.runs, {}, { headers: { Origin: "http://127.0.0.1:14872" } }),
      403,
      "forbidden",
    );

    return { unauthenticatedDenied: true, invalidTokenDenied: true, crossOriginDenied: true };
  });

  await journey.evidence.check("compile_upload_graph_bundles_source", async () => {
    const body = await Effect.runPromise(compileFixture("execution.ts"));
    assert(body.bundles.length === 2, "expected_two_compiled_bundles");
    assert(body.sourceArtifact?.status === "available", "source_not_captured");
    await journey.upload(body);

    const graph = await journey.call(routes.graph, {
      params: { slug },
      query: { workspace: "fixtures" },
    });

    equal(graph.revision, body.revision, "uploaded_revision_changed");

    const source = await journey.call(routes.source, {
      params: { slug },
      query: { workspace: "fixtures" },
    });

    equal(source, body.sourceArtifact, "uploaded_source_changed");
    cursor = await journey.call(routes.cursor, {});

    return {
      bundles: body.bundles.length,
      nodes: body.graph.nodes.length,
      revision: body.revision,
      sourceCaptured: true,
    };
  });

  await journey.evidence.check("run_input_validation", async () => {
    const runs = { query: { slug, limit: 200 } };
    const before = await journey.call(routes.runs, runs);

    const malformed: Json[] = [{ name: 123, chooseYes: true, items: [] }, { name: "fixture" }];

    for (const input of malformed) {
      await journey.denied(
        journey.send(routes.startRun, { params: { slug }, body: { input, workspace: "fixtures" } }),
        400,
        "bad_request",
      );
    }

    const after = await journey.call(routes.runs, runs);
    equal(
      after.map((run) => run.id),
      before.map((run) => run.id),
      "invalid_input_created_run",
    );

    return { malformedInputsDenied: 2, noRunCreated: true };
  });

  for (const chooseYes of [true, false]) {
    await journey.evidence.check(
      `docker_execution_branch_${chooseYes ? "yes" : "no"}_map_parallel_retry_logs`,
      async () => {
        const run = await journey.start(slug, { name: "fixture", chooseYes, items: [2, 4, 6] });
        executionId = run.id;

        return execution(journey, run.id, chooseYes);
      },
    );
  }

  await journey.evidence.check("docker_network_none_and_retained_retry_workspace", async () => {
    assert(executionId, "execution_case_dependency_missing");

    return docker(journey, executionId);
  });

  await journey.evidence.check("approval_wait_and_invalid_payload", async () => {
    const first = await Effect.runPromise(compileFixture("approval-one.ts"));
    firstRevision = first.revision;
    await journey.upload(first);
    firstSource = await journey.call(routes.source, {
      params: { slug: approvalSlug },
      query: { workspace: "fixtures" },
    });
    const run = await journey.start(approvalSlug, { name: "fixture" });
    approvalId = run.id;
    const waiting = await journey.waitForHook(run.id);
    assert(waiting.run.waitingOn?.hook === "approval", "approval_wait_not_registered", {
      runId: run.id,
      runStatus: waiting.run.status,
    });
    const hook = { id: run.id, name: "approval" };
    await journey.denied(
      journey.send(routes.resolveNamedHook, {
        params: hook,
        body: { payload: { approved: "yes" } },
      }),
      400,
      "bad_request",
    );
    const after = await journey.call(routes.run, { params: { id: run.id } });
    assert(after.run.waitingOn?.hook === "approval", "invalid_payload_consumed_approval");
    await journey.denied(
      journey.send(
        routes.resolveNamedHook,
        { params: hook, body: { payload: { approved: true } } },
        { principal: "other" },
      ),
      404,
      "not_found",
    );

    return {
      runId: run.id,
      waiting: true,
      invalidPayloadDenied: true,
      otherWorkspaceResolveDenied: true,
    };
  });

  await journey.evidence.check("revision_pinning_after_new_save_and_approval_resolve", async () => {
    assert(approvalId && firstRevision, "approval_case_dependency_missing");
    const second = await Effect.runPromise(compileFixture("approval-two.ts"));
    assert(second.revision !== firstRevision, "revision_fixture_did_not_change");
    await journey.upload(second);

    const current = await journey.call(routes.graph, {
      params: { slug: approvalSlug },
      query: { workspace: "fixtures" },
    });

    const pinned = await journey.call(routes.runGraph, { params: { id: approvalId } });
    equal(current.revision, second.revision, "current_graph_not_updated");
    equal(pinned.revision, firstRevision, "existing_run_revision_changed");
    equal(
      await journey.call(routes.runSource, { params: { id: approvalId } }),
      firstSource,
      "existing_run_source_changed",
    );
    await journey.call(routes.resolveNamedHook, {
      params: { id: approvalId, name: "approval" },
      body: { payload: { approved: true } },
    });
    const completed = await journey.wait(approvalId);
    assert(completed.run.status === "succeeded", "pinned_run_failed", {
      runId: approvalId,
      runStatus: completed.run.status,
    });
    equal(
      completed.run.output,
      { name: "fixture", approved: true, version: 1 },
      "pinned_bundle_not_executed",
    );
    const next = await journey.start(approvalSlug, { name: "fixture" });
    const waiting = await journey.waitForHook(next.id);
    assert(waiting.run.waitingOn?.hook === "approval", "new_revision_did_not_wait");
    await journey.call(routes.resolveNamedHook, {
      params: { id: next.id, name: "approval" },
      body: { payload: { approved: true } },
    });
    const latest = await journey.wait(next.id);
    assert(latest.run.status === "succeeded", "new_revision_run_failed", {
      runId: next.id,
      runStatus: latest.run.status,
    });
    equal(
      latest.run.output,
      { name: "fixture", approved: true, version: 2 },
      "new_bundle_not_executed",
    );

    return {
      originalRunId: approvalId,
      newRunId: next.id,
      pinnedRevision: firstRevision,
      latestRevision: second.revision,
      versionsExecuted: ["1", "2"],
    };
  });

  await journey.evidence.check("cross_workspace_query_body_and_run_isolation", async () => {
    assert(executionId, "execution_case_dependency_missing");

    return isolation(journey, executionId);
  });
  await journey.evidence.check("bounded_run_node_log_feed_pages", async () => {
    assert(executionId, "execution_case_dependency_missing");

    return pages(journey, executionId);
  });
  await journey.evidence.check("sse_reconnect_transaction_cursor_with_real_events", async () => {
    assert(cursor, "cursor_case_dependency_missing");
    let first = await frame(journey, cursor.cursor, cursor.epoch);

    for (let skipped = 0; first.events.length < 2 && skipped < 30; skipped += 1) {
      first = await frame(journey, first.id, cursor.epoch);
    }

    assert(first.events.length > 1, "sse_multi_event_transaction_not_exercised");
    const second = await frame(journey, cursor.cursor, cursor.epoch, first.id);
    assert(second.id > first.id, "sse_reconnect_did_not_advance");
    assert(
      first.events.some((event) => event.runId && journey.evidence.runs.includes(event.runId)),
      "sse_first_frame_has_no_journey_run",
    );

    const transaction = await journey.call(routes.eventHistory, {
      query: { txn: first.events[0]?.txn ?? "", limit: 200 },
    });

    equal(
      first.events.map((event) => event.sequence).sort((a, b) => a - b),
      transaction.items.map((event) => event.sequence).sort((a, b) => a - b),
      "sse_transaction_incomplete",
    );

    if (first.events.length > 1) {
      await journey.denied(
        journey.send(routes.events, {
          query: { after: first.events[0]?.sequence ?? 0, epoch: cursor.epoch },
        }),
        410,
        "stale_cursor",
      );
    }

    await journey.denied(
      journey.send(routes.events, { query: { after: second.id, epoch: "wrong-journey-epoch" } }),
      410,
      "stale_cursor",
    );

    return {
      firstCursor: first.id,
      reconnectCursor: second.id,
      firstEvents: first.events.length,
      reconnectEvents: second.events.length,
      acknowledgedEventsRepeated: false,
    };
  });
  const { results } = journey.evidence;
  const failed = results.filter((result) => result.status === "failed").length;
  process.stdout.write(
    `${JSON.stringify({ status: failed ? "failed" : "passed", passed: results.length - failed, failed, evidence: ".notes/cloud/evidence/journey.json", scope: "local-stack-journey-only" })}\n`,
  );
  process.exitCode = failed ? 1 : 0;
}

await main().catch((cause: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ status: "failed", failure: "journey_initialization_failed", cause: failureEvidence(cause) })}\n`,
  );
  process.exitCode = 1;
});
