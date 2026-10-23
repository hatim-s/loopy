import { createHash } from "node:crypto";
import { Attempts } from "../../apps/sandbox/src/attempts.js";
import { DockerBackend } from "../../apps/sandbox/src/docker.js";
import { filesystemDependencies } from "../../apps/sandbox/src/filesystem.js";
import { sandboxAttemptRequestSchema } from "../../packages/loopy/src/contract/index.js";
import { assert, equal, JourneyFailure } from "./journey-client.js";
import { type FaultMode, TransportFaults } from "./transport-failure-faults.js";
import {
  type Config,
  cleanup,
  command,
  docker,
  marker,
  oneReceipt,
  ownedContainer,
  ownerOf,
  receipts,
  until,
} from "./transport-failure-resources.js";

function request(mode: FaultMode) {
  const sleepMs = mode === "kill_wait_client" ? 6000 : 60_000;

  const bytes = Buffer.from(
    [
      "import { appendFile } from 'node:fs/promises';",
      "await appendFile('/workspace/effect.txt', 'started\\n');",
      `await Bun.sleep(${sleepMs});`,
      "await appendFile('/workspace/effect.txt', 'finished\\n');",
      "process.stdout.write(JSON.stringify({ok:true}));",
    ].join("\n"),
  );

  const hash = createHash("sha256").update(bytes).digest("hex");

  return sandboxAttemptRequestSchema.parse({
    workspace: "transport-fixtures",
    executionKey: { runId: `transport-${mode}`, nodeId: "0:code", scope: [] },
    attempt: 1,
    spec: { kind: "code", bundleHash: hash, input: {}, timeoutMs: 90_000 },
    bundles: [{ hash, bytes: bytes.toString("base64") }],
  });
}

export async function scenario(config: Config, mode: FaultMode) {
  config.maxTimeoutMs = mode === "kill_wait_client" ? 20_000 : 12_000;
  const faults = new TransportFaults(config, mode);
  const backend = () => new DockerBackend(config, faults.runner);
  const input = request(mode);

  let service: Attempts | null = await Attempts.open(
    config,
    filesystemDependencies(config, { backend: backend() }),
  );

  const initialService = service;
  let cleanupEvidence: Awaited<ReturnType<typeof cleanup>> | undefined;
  let result: Awaited<ReturnType<typeof prove>> | undefined;
  let failure: string | undefined;
  let failureEvidence: JourneyFailure["evidence"] | undefined;

  async function prove() {
    assert(service, "service_missing");
    equal(await service.start(input), { kind: "started" }, "initial_admission_failed");
    await until(
      async () => faults.events,
      (events) => events.some((event) => event.operation === "container ls"),
    );
    const original = await oneReceipt(config);
    assert(original.kind === "started", "transport_error_finished_receipt");
    const before = await ownedContainer(config, original);
    assert(before.State.Running, "worker_not_running_during_outage");
    equal(await service.lookup(input), { kind: "started" }, "outage_lookup_not_started");
    equal(
      await Promise.all([service.start(input), service.start(input)]),
      [{ kind: "started" }, { kind: "started" }],
      "duplicate_outage_admission_changed",
    );
    await until(
      () => marker(original),
      (text) => text === "started\n",
    );

    const workerHash = (
      await docker(["exec", original.container, "sha256sum", "/opt/loopy/worker.js"])
    )
      .trim()
      .split(/\s+/)[0];

    assert(workerHash && /^[a-f0-9]{64}$/.test(workerHash), "invalid_image_worker_hash");
    let reopenedAt: number | null = null;

    if (mode === "unavailable_inspect_socket") {
      await service.close();
      service = null;
      await Bun.sleep(1200);
      equal(await oneReceipt(config), original, "receipt_changed_while_closed");
      assert(
        (await ownedContainer(config, original)).State.Running,
        "worker_not_running_while_service_closed",
      );
      faults.restore();
      reopenedAt = Date.now();
      assert(reopenedAt < original.deadline, "reopened_after_deadline");
      service = await Attempts.open(config, filesystemDependencies(config, { backend: backend() }));
      assert(service !== initialService, "service_was_not_reconstructed");
    } else {
      faults.restore();
    }

    equal(await oneReceipt(config), original, "recovery_changed_admission_or_deadline");
    equal(
      await service.start(input),
      { kind: "started" },
      "recovered_duplicate_repeated_admission",
    );
    const timeout = Promise.withResolvers<never>();

    const timer = setTimeout(
      () => timeout.reject(new Error("Original worker deadline was abandoned.")),
      config.maxTimeoutMs + 5000,
    );

    try {
      await Promise.race([service.drain(), timeout.promise]);
    } finally {
      clearTimeout(timer);
    }

    const terminal = await service.lookup(input);
    assert(terminal.kind === "finished", "attempt_did_not_finish");
    const completedAt = Date.now();
    const final = await oneReceipt(config);
    equal(final.deadline, original.deadline, "original_deadline_changed");
    equal(final.id, original.id, "admission_identity_changed");
    equal(final.container, original.container, "container_identity_changed");
    equal(final.attempt, 1, "attempt_changed");
    const after = await ownedContainer(config, original);
    equal(after.Id, before.Id, "container_replaced");
    equal(after.State.StartedAt, before.State.StartedAt, "container_restarted");
    assert(!after.State.Running, "terminal_receipt_worker_running");
    const artifact = await service.artifact({ ...input, path: "effect.txt" });
    const text = Buffer.from(artifact.bytes, "base64").toString("utf8");

    if (mode === "kill_wait_client") {
      equal(
        terminal.result,
        { kind: "succeeded", output: { ok: true }, logs: [] },
        "lost_wait_completion_not_recovered",
      );
      equal(text, "started\nfinished\n", "lost_wait_repeated_effect");
    } else {
      assert(terminal.result.kind === "failed", "deadline_did_not_fail");
      equal(terminal.result.error.code, "execution", "deadline_error_code_changed");
      equal(
        terminal.result.error.message,
        "Attempt timed out. Its owned container was killed.",
        "original_worker_not_timed_out",
      );
      equal(text, "started\n", "timed_out_effect_repeated_or_finished");
      assert(
        completedAt >= original.deadline && completedAt <= original.deadline + 3000,
        "original_deadline_not_observed",
      );
    }

    equal(await service.start(input), terminal, "terminal_duplicate_not_replayed");
    await Bun.sleep(200);
    equal(await oneReceipt(config), final, "terminal_duplicate_mutated_receipt");
    const starts = faults.calls.filter((call) => call.operation === "start");
    equal(starts.length, 1, "docker_start_repeated");
    equal(starts[0]?.args, ["start", original.container], "docker_started_another_container");
    equal(
      faults.calls.filter(
        (call) => call.operation === "create" && call.args.includes(original.container),
      ).length,
      1,
      "worker_created_twice",
    );
    equal((await receipts(config)).length, 1, "additional_admission_found");
    equal(
      faults.calls.filter((call) => call.operation === "kill").length,
      mode === "kill_wait_client" ? 0 : 1,
      "unexpected_worker_kill_count",
    );

    return {
      mode,
      stateRoot: config.stateRoot,
      owner: ownerOf(config),
      receiptId: original.id,
      container: original.container,
      dockerContainerId: before.Id,
      workerStartedAt: before.State.StartedAt,
      imageWorkerSha256: workerHash,
      deadline: original.deadline,
      reopenedAt,
      completedAt,
      completionRelativeToDeadlineMs: completedAt - original.deadline,
      result: terminal.result,
      marker: text,
      starts: starts.length,
      admissions: 1,
      attempt: 1,
      sameContainerAndStartTime: true,
      originalDeadlinePreserved: true,
      duplicateAdmissions: { duringOutage: 2, afterRecovery: 1, afterCompletion: 1 },
      faults: faults.events,
      dockerCalls: faults.calls.map((call) => ({ operation: call.operation, at: call.at })),
    };
  }

  try {
    result = await prove();
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : "Unexpected fixture error.";
    failureEvidence = cause instanceof JourneyFailure ? cause.evidence : undefined;
  } finally {
    await service?.close();
    cleanupEvidence = await cleanup(config);
    equal(faults.activeCalls, 0, "background_runner_call_remains");

    for (const pid of faults.waitPids) {
      const status = await command(["/bin/ps", "-p", String(pid), "-o", "pid="]);
      assert(status.exitCode !== 0 && status.stdout.trim() === "", "owned_wait_process_remains");
    }
  }

  return {
    status: failure ? "failed" : "passed",
    failure,
    failureEvidence,
    proof: result,
    cleanup: {
      ...cleanupEvidence,
      ownedBackgroundProcessesRemaining: 0,
      activeRunnerCalls: faults.activeCalls,
    },
  };
}
