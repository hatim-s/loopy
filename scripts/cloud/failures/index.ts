import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Effect } from "effect";
import { routes } from "../../../packages/loopy/src/contract";
import { assert, equal } from "../journey/client";
import { FailureJourney } from "./client";
import { root } from "./config";
import { docker, ownedContainer } from "./resources";

const journey = new FailureJourney();

let approvalId: string | undefined;

await journey.check("isolated_stack_start_and_compile", async () => {
  await journey.stack.start();

  const bodies = await Effect.runPromise(
    Effect.forEach(
      ["failure-command.ts", "failure-timeout.ts", "failure-approval.ts", "failure-schedule.ts"],
      (fixture) => journey.compiled(fixture),
      { concurrency: 1 },
    ),
  );

  for (const body of bodies) {
    await journey.json(routes.putLoopy.response, `/loopies/${body.graph.name}`, body, "PUT");
  }

  return { compiledFixtures: 4, apiPort: 14970, sandboxPort: 14971, inspectorPort: 14973 };
});

try {
  if (journey.results.some((result) => result.status === "failed")) {
    throw new Error("Isolated stack setup failed.");
  }

  await journey.check("process_loss_running_effect_duplicate_admission_late_receipt", async () => {
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
    const stopped = await ownedContainer(receipt.container);
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

  await journey.check("approval_wait_survives_process_restart", async () => {
    assert(approvalId, "approval_dependency_missing");
    const waiting = await journey.snapshot(approvalId);
    assert(waiting.run.waitingOn?.hook === "approval", "approval_wait_lost_after_restart");
    const hookCount = waiting.hooks.length;
    await journey.json(routes.resolveNamedHook.response, `/runs/${approvalId}/hooks/approval`, {
      payload: { approved: true },
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

  await journey.check("docker_worker_kill_uncertain_without_retry", async () => {
    const run = await journey.start("cloud-failure-command");
    const { receipt, request } = await journey.running(run.id);
    const container = await ownedContainer(receipt.container);
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
    assert(!(await ownedContainer(receipt.container)).State.Running, "killed_worker_still_running");
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

  await journey.check("command_timeout_stops_side_effect", async () => {
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
    assert(!(await ownedContainer(saved.container)).State.Running, "timeout_worker_still_running");
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

  await journey.check("scheduled_firing_overlap_and_restart_deduplication", async () => {
    const slug = "cloud-failure-schedule";
    const prior = await journey.json(routes.runs.response, `/runs?slug=${slug}&limit=200`);
    const existing = new Set(prior.map((run) => run.id));

    const schedule = await journey.json(
      routes.putSchedule.response,
      `/loopies/${slug}/schedule`,
      { input: {}, enabled: true },
      "PUT",
    );

    const list = async () =>
      (await journey.json(routes.runs.response, `/runs?slug=${slug}&limit=200`)).filter(
        (run) => !existing.has(run.id),
      );

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
      journey.runs.push(first.id);
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
        (await ownedContainer(firstWorker.receipt.container)).State.Running &&
          (await ownedContainer(secondWorker.receipt.container)).State.Running,
        "scheduled_workers_did_not_overlap",
      );
      await journey.json(routes.setScheduleEnabled.response, `/loopies/${slug}/schedule/enabled`, {
        enabled: false,
      });

      for (const run of both) {
        const waiting = await journey.until(
          () => journey.snapshot(run.id),
          (value) => value.run.waitingOn?.hook === "approval",
          "overlapping_run_did_not_wait",
          90_000,
        );

        const saved = await journey.assertSingleAttempt(waiting);
        equal(await journey.artifact(saved), "fired\nfinished\n", "scheduled_effect_repeated");

        if (!journey.runs.includes(run.id)) {
          journey.runs.push(run.id);
        }
      }

      const current = (
        await journey.json(routes.schedules.response, "/schedules?workspace=fixtures")
      ).find((value) => value.slug === slug);

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
      await journey.json(routes.setScheduleEnabled.response, `/loopies/${slug}/schedule/enabled`, {
        enabled: false,
      });
    }
  });
} catch {
  // The setup result already contains the safe, reproducible failure.
} finally {
  await journey.check("cleanup_owned_processes_containers_volumes", () => journey.stack.close());
  const sourceHashes: Record<string, string> = {};

  for (const path of [
    "apps/cloud/src/scheduler.ts",
    "apps/sandbox/src/attempt/index.ts",
    "apps/sandbox/src/docker/index.ts",
  ]) {
    sourceHashes[path] = createHash("sha256")
      .update(new Uint8Array(await Bun.file(resolve(root, path)).arrayBuffer()))
      .digest("hex");
  }

  await journey.save({ sourceHashes });
}

process.exitCode = journey.results.some((result) => result.status === "failed") ? 1 : 0;
