import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { assert, equal, failureEvidence } from "../shared/assert";
import { compileFixture } from "../shared/compile-fixture";
import { FAILURE_JOURNEY_SOURCES, sourceHashes } from "../shared/sources";
import { root } from "../stack/constants";
import { FailureJourney } from "./client";
import { ports } from "./config";
import { docker, owned } from "./resources";

const journey = new FailureJourney();

const { api, evidence } = journey;

let approvalId: string | undefined;

let setupFailure: ReturnType<typeof failureEvidence> | null = null;

await evidence.check("isolated_stack_start_and_compile", async () => {
  await journey.stack.start();

  const bodies = await Effect.runPromise(
    Effect.forEach(
      ["failure-command.ts", "failure-timeout.ts", "failure-approval.ts", "failure-schedule.ts"],
      compileFixture,
      { concurrency: 1 },
    ),
  );

  for (const body of bodies) {
    await api.call(routes.putLoopy, { params: { slug: body.graph.name }, body });
  }

  return {
    compiledFixtures: 4,
    apiPort: ports.api,
    sandboxPort: ports.sandbox,
    inspectorPort: ports.inspector,
  };
});

try {
  if (!evidence.passed) {
    throw new Error("Isolated stack setup failed.");
  }

  await evidence.check("process_loss_running_effect_duplicate_admission_late_receipt", async () => {
    const approval = await journey.start("cloud-failure-approval");
    approvalId = approval.id;
    await journey.until(
      () => journey.snapshot(approval.id),
      (value) => value.run.waitingOn?.hook === "approval",
      "approval_not_waiting",
    );
    const run = await journey.start("cloud-failure-command");
    const { receipt, request } = await journey.running(run.id);
    await journey.duplicate(request, "started");
    const restart = await journey.stack.restart(14_000);
    const stopped = await owned.container(receipt);
    assert(!stopped.State.Running, "command_did_not_finish_during_process_loss");
    const finished = await journey.wait(run.id);
    assert(finished.run.status === "succeeded", "recovered_command_failed", {
      status: finished.run.status,
    });
    const saved = await journey.assertSingleAttempt(finished);
    equal(await journey.artifact(saved), "started\nfinished\n", "restarted_effect_ran_twice");
    await journey.duplicate(request, "finished");
    await Bun.sleep(1500);
    equal(await journey.artifact(saved), "started\nfinished\n", "late_admission_repeated_effect");
    await journey.assertSingleAttempt(await journey.snapshot(run.id));

    return {
      runId: run.id,
      receiptId: saved.id,
      container: saved.container,
      attempt: 1,
      startedDuplicateRequests: 2,
      finishedDuplicateRequests: 2,
      effectLines: 2,
      processLossMs: 14_000,
      workerPidBefore: restart.before.worker,
      workerPidAfter: restart.after.worker ?? 0,
      providerPidBefore: restart.before.provider,
      providerPidAfter: restart.after.provider ?? 0,
      recoveredFinishedReceipt: true,
    };
  });

  await evidence.check("approval_wait_survives_process_restart", async () => {
    assert(approvalId, "approval_dependency_missing");
    const waiting = await journey.snapshot(approvalId);
    assert(waiting.run.waitingOn?.hook === "approval", "approval_wait_lost_after_restart");
    const hookCount = waiting.hooks.length;
    await api.call(routes.resolveNamedHook, {
      params: { id: approvalId, name: "approval" },
      body: { payload: { approved: true } },
    });
    const finished = await journey.wait(approvalId);
    assert(finished.run.status === "succeeded", "persisted_approval_failed");
    equal(finished.run.output, { approved: true }, "persisted_approval_output_changed");

    return {
      runId: approvalId,
      hookCountBeforeResolution: hookCount,
      status: finished.run.status,
      approved: true,
    };
  });

  await evidence.check("docker_worker_kill_uncertain_without_retry", async () => {
    const run = await journey.start("cloud-failure-command");
    const { receipt, request } = await journey.running(run.id);
    const container = await owned.container(receipt);
    assert(container.State.Running, "kill_target_not_running");
    const killedAt = Date.now();
    await docker(["kill", receipt.container]);
    const finished = await journey.wait(run.id);
    assert(finished.run.status === "failed", "killed_worker_run_not_failed");
    const saved = await journey.assertSingleAttempt(finished);
    assert(
      saved.kind === "finished" &&
        saved.result.kind === "failed" &&
        saved.result.error.code === "uncertain",
      "killed_worker_not_uncertain",
    );
    assert(!(await owned.container(receipt)).State.Running, "killed_worker_still_running");
    await journey.duplicate(request, "finished");
    await Bun.sleep(2000);
    await journey.assertSingleAttempt(await journey.snapshot(run.id));
    equal(await journey.artifact(saved), "started\n", "unknown_effect_was_retried");

    return {
      runId: run.id,
      attempt: 1,
      errorCode: "uncertain",
      configuredAttempts: 3,
      effectLines: 1,
      failureObservedMs: Date.now() - killedAt,
      runningAfterFailure: false,
    };
  });

  await evidence.check("command_timeout_stops_side_effect", async () => {
    const run = await journey.start("cloud-failure-timeout");
    const started = Date.now();
    const finished = await journey.wait(run.id);
    assert(finished.run.status === "failed", "timeout_run_not_failed");
    const saved = await journey.assertSingleAttempt(finished);
    assert(
      saved.kind === "finished" &&
        saved.result.kind === "failed" &&
        saved.result.error.code === "execution",
      "timeout_error_code_changed",
    );
    assert(!(await owned.container(saved)).State.Running, "timeout_worker_still_running");
    equal(await journey.artifact(saved), "started\n", "timeout_effect_finished");

    return {
      runId: run.id,
      configuredTimeoutMs: 1000,
      failureObservedMs: Date.now() - started,
      attempt: 1,
      errorCode: "execution",
      effectLines: 1,
      runningAfterFailure: false,
    };
  });

  await evidence.check("scheduled_firing_overlap_and_restart_deduplication", async () => {
    const slug = "cloud-failure-schedule";
    const runs = { query: { slug, limit: 200 } };
    const prior = await api.call(routes.runs, runs);
    const existing = new Set(prior.map((run) => run.id));

    const schedule = await api.call(routes.putSchedule, {
      params: { slug },
      body: { input: {}, enabled: true },
    });

    const disable = () =>
      api.call(routes.setScheduleEnabled, { params: { slug }, body: { enabled: false } });

    const list = async () =>
      (await api.call(routes.runs, runs)).filter((run) => !existing.has(run.id));

    try {
      const first = (
        await journey.until(
          list,
          (runs) => runs.length === 1,
          "first_schedule_did_not_fire",
          75_000,
        )
      )[0];

      assert(first, "scheduled_run_missing");
      evidence.runs.push(first.id);
      const firstWorker = await journey.running(first.id, "fired\n");
      await journey.stack.restart();
      equal(
        (await list()).map((run) => run.id),
        [first.id],
        "restart_duplicated_schedule_fire",
      );

      const both = await journey.until(
        list,
        (runs) => runs.length === 2,
        "second_schedule_did_not_fire",
        75_000,
      );

      const second = both.find((run) => run.id !== first.id);
      assert(second, "second_scheduled_run_missing");
      const secondWorker = await journey.running(second.id, "fired\n");
      assert(
        (await owned.container(firstWorker.receipt)).State.Running &&
          (await owned.container(secondWorker.receipt)).State.Running,
        "scheduled_workers_did_not_overlap",
      );
      await disable();

      for (const run of both) {
        const waiting = await journey.until(
          () => journey.snapshot(run.id),
          (value) => value.run.waitingOn?.hook === "approval",
          "overlapping_run_did_not_wait",
          90_000,
        );

        const saved = await journey.assertSingleAttempt(waiting);
        equal(await journey.artifact(saved), "fired\nfinished\n", "scheduled_effect_repeated");

        if (!evidence.runs.includes(run.id)) {
          evidence.runs.push(run.id);
        }
      }

      const current = (await api.call(routes.schedules, { query: { workspace: "fixtures" } })).find(
        (value) => value.slug === slug,
      );

      assert(current?.lastFireKey, "scheduled_fire_key_missing");
      const firedAt = both.map((run) => Date.parse(run.createdAt)).sort((a, b) => a - b);
      assert((firedAt[1] ?? 0) - (firedAt[0] ?? 0) >= 50_000, "schedule_fired_twice_in_one_minute");

      return {
        runIds: both.map((run) => run.id),
        firstDeadline: schedule.nextFireAt,
        lastFireKey: current.lastFireKey,
        scheduledRuns: 2,
        concurrentRunningDockerWorkers: 2,
        simultaneousApprovalWaits: 2,
        effectStartsPerRun: 1,
        duplicateRunsAfterRestart: 0,
        overlapPolicyObserved:
          "consecutive minute fires run concurrently, then both persist approval waits",
      };
    } finally {
      await disable();
    }
  });
} catch (cause) {
  setupFailure = failureEvidence(cause);
} finally {
  await evidence.check("cleanup_owned_processes_containers_volumes", () => journey.stack.close());
  await evidence.save({
    setupFailure,
    sourceHashes: await sourceHashes(root, FAILURE_JOURNEY_SOURCES),
  });
}

process.exitCode = evidence.passed ? 0 : 1;
