import { decodeBoundary, sandboxAttemptRequestSchema } from "@loopy/contract";
import { Cause, Effect, Exit } from "effect";
import { DockerArtifacts } from "../../../sandbox/src/artifacts";
import { Attempts } from "../../../sandbox/src/attempt";
import { DockerBackend } from "../../../sandbox/src/docker";
import { DockerClient } from "../../../sandbox/src/docker/client";
import { filesystemStorage } from "../../../sandbox/src/filesystem";
import { assert, equal } from "../shared/assert";
import { sha256Hex } from "../shared/hash";
import { type FaultMode, TransportFaults } from "./faults";
import { fixtureFailure } from "./fixture-effect";
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
} from "./resources";

// The inspect outage holds the worker past a shorter deadline; the wait kill lets it finish.
export const maxTimeoutMs = {
  kill_wait_client: 20_000,
  unavailable_inspect_socket: 12_000,
} as const satisfies Record<FaultMode, number>;

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

  const hash = sha256Hex(bytes);

  return decodeBoundary(sandboxAttemptRequestSchema)({
    workspace: "transport-fixtures",
    executionKey: { runId: `transport-${mode}`, nodeId: "0:code", scope: [] },
    attempt: 1,
    spec: { kind: "code", bundleHash: hash, input: {}, timeoutMs: 90_000 },
    bundles: [{ hash, bytes: bytes.toString("base64") }],
  });
}

export function scenario(config: Config, mode: FaultMode) {
  // Cleanup runs once after the proof, including when the proof is interrupted.
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const faults = new TransportFaults(config, mode);
      const proof = yield* Effect.exit(restore(Effect.scoped(prove(config, mode, faults))));
      const cleanupEvidence = yield* cleanup(config);
      equal(faults.activeCalls, 0, "background_runner_call_remains");

      for (const pid of faults.waitPids) {
        const status = yield* command(["/bin/ps", "-p", String(pid), "-o", "pid="]);

        assert(status.exitCode !== 0 && status.stdout.trim() === "", "owned_wait_process_remains");
      }

      const failure = Exit.isFailure(proof) ? fixtureFailure(Cause.squash(proof.cause)) : undefined;

      return {
        status: Exit.isFailure(proof) ? "failed" : "passed",
        failure: failure?.failure,
        failureEvidence: failure?.failureEvidence,
        proof: Exit.isSuccess(proof) ? proof.value : undefined,
        cleanup: {
          ...cleanupEvidence,
          ownedBackgroundProcessesRemaining: 0,
          activeRunnerCalls: faults.activeCalls,
        },
      };
    }),
  );
}

function prove(config: Config, mode: FaultMode, faults: TransportFaults) {
  return Effect.gen(function* () {
    const input = request(mode);

    const open = () =>
      Attempts.open(config, () =>
        Effect.sync(() => ({
          ...filesystemStorage(config.stateRoot),
          backend: new DockerBackend(config, new DockerClient(config, faults.runner)),
          artifactReader: new DockerArtifacts(config, new DockerClient(config)),
        })),
      );

    let service = yield* open();
    // The service may still own monitors and locks when the proof is interrupted.
    yield* Effect.addFinalizer(() => Effect.suspend(() => service.close()).pipe(Effect.orDie));
    const initialService = service;
    equal(yield* service.start(input), { kind: "started" }, "initial_admission_failed");
    yield* until(
      () => Effect.succeed(faults.events),
      (events) => events.some((event) => event.operation === "container ls"),
    );
    const original = yield* oneReceipt(config);
    assert(original.kind === "started", "transport_error_finished_receipt");
    const before = yield* ownedContainer(config, original);
    assert(before.State.Running, "worker_not_running_during_outage");
    equal(yield* service.lookup(input), { kind: "started" }, "outage_lookup_not_started");
    equal(
      yield* Effect.all([service.start(input), service.start(input)], {
        concurrency: "unbounded",
      }),
      [{ kind: "started" }, { kind: "started" }],
      "duplicate_outage_admission_changed",
    );
    yield* until(
      () => marker(original),
      (text) => text === "started\n",
    );

    const workerHash = (yield* docker([
      "exec",
      original.container,
      "sha256sum",
      "/opt/loopy/worker.js",
    ]))
      .trim()
      .split(/\s+/)[0];

    assert(workerHash && /^[a-f0-9]{64}$/.test(workerHash), "invalid_image_worker_hash");
    let reopenedAt: number | null = null;

    if (mode === "unavailable_inspect_socket") {
      yield* service.close();
      yield* Effect.sleep(1200);
      equal(yield* oneReceipt(config), original, "receipt_changed_while_closed");
      assert(
        (yield* ownedContainer(config, original)).State.Running,
        "worker_not_running_while_service_closed",
      );
      faults.restore();
      reopenedAt = Date.now();
      assert(reopenedAt < original.deadline, "reopened_after_deadline");
      service = yield* open();
      assert(service !== initialService, "service_was_not_reconstructed");
    } else {
      faults.restore();
    }

    equal(yield* oneReceipt(config), original, "recovery_changed_admission_or_deadline");
    equal(
      yield* service.start(input),
      { kind: "started" },
      "recovered_duplicate_repeated_admission",
    );
    yield* service.drain().pipe(
      Effect.timeoutOrElse({
        duration: config.maxTimeoutMs + 5000,
        orElse: () => Effect.fail(new Error("Original worker deadline was abandoned.")),
      }),
    );

    const terminal = yield* service.lookup(input);
    assert(terminal.kind === "finished", "attempt_did_not_finish");
    const completedAt = Date.now();
    const final = yield* oneReceipt(config);
    equal(final.deadline, original.deadline, "original_deadline_changed");
    equal(final.id, original.id, "admission_identity_changed");
    equal(final.container, original.container, "container_identity_changed");
    equal(final.attempt, 1, "attempt_changed");
    const after = yield* ownedContainer(config, original);
    equal(after.Id, before.Id, "container_replaced");
    equal(after.State.StartedAt, before.State.StartedAt, "container_restarted");
    assert(!after.State.Running, "terminal_receipt_worker_running");
    const artifact = yield* service.artifact({ ...input, path: "effect.txt" });
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

    equal(yield* service.start(input), terminal, "terminal_duplicate_not_replayed");
    yield* Effect.sleep(200);
    equal(yield* oneReceipt(config), final, "terminal_duplicate_mutated_receipt");
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
    equal((yield* receipts(config)).length, 1, "additional_admission_found");
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
  });
}
