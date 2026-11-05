import { Effect, Result, Semaphore } from "effect";
import {
  type SandboxAttemptRequest,
  type SandboxReceipt,
} from "../../../packages/loopy/src/contract/index.js";
import {
  type AttemptRecord,
  type AuthoritySession,
  attemptResourceNames,
  type DockerAttemptPlan,
  workspaceVolumeInput,
} from "../../../packages/loopy/src/contract/sandbox-journal.js";
import { durationMs } from "../../../packages/loopy/src/core/index.js";
import {
  AttemptConflict,
  attemptHash,
  attemptId,
  InvalidAttempt,
  validateBundles,
} from "./admission.js";
import type { AttemptDependencies } from "./attempt-dependencies.js";
import type { AttemptExports } from "./attempt-exports.js";
import type { AttemptMonitors } from "./attempt-monitor.js";
import { resolveAdmissionRead } from "./attempt-reconciliation.js";
import type { SandboxConfig } from "./config.js";
import type { SandboxFailure } from "./operations.js";
import { failure } from "./operations.js";
import { publicReceipt } from "./receipt-view.js";
import type { Stopping } from "./stopping.js";

export class AttemptAdmissions {
  private readonly admissions = new Map<string, { mutex: Semaphore.Semaphore; users: number }>();
  // Never clear issued ids: a stale started read can arrive after terminal publication.
  private readonly issued = new Set<string>();
  private readonly retained = new Map<
    string,
    { request: SandboxAttemptRequest; requestHash: string }
  >();
  private readonly config: SandboxConfig;
  private readonly dependencies: AttemptDependencies;
  private readonly session: AuthoritySession;
  private readonly monitors: AttemptMonitors;
  private readonly exports: AttemptExports;
  private readonly stopping: Stopping;
  constructor(options: {
    config: SandboxConfig;
    dependencies: AttemptDependencies;
    session: AuthoritySession;
    monitors: AttemptMonitors;
    exports: AttemptExports;
    stopping: Stopping;
  }) {
    this.config = options.config;
    this.dependencies = options.dependencies;
    this.session = options.session;
    this.monitors = options.monitors;
    this.exports = options.exports;
    this.stopping = options.stopping;
  }

  wait(id: string) {
    return Effect.suspend(() =>
      this.admissions.has(id) ? this.withAdmission(id, Effect.void) : Effect.void,
    );
  }
  private withAdmission<A, E>(id: string, operation: Effect.Effect<A, E>) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        let entry = this.admissions.get(id);

        if (!entry) {
          entry = { mutex: Semaphore.makeUnsafe(1), users: 0 };
          this.admissions.set(id, entry);
        }

        const current = entry;
        current.users++;

        return restore(current.mutex.withPermit(operation)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              current.users--;

              if (current.users === 0) {
                this.admissions.delete(id);
              }
            }),
          ),
        );
      }),
    );
  }
  start(request: SandboxAttemptRequest): Effect.Effect<SandboxReceipt, SandboxFailure> {
    return Effect.gen({ self: this }, function* () {
      if (this.stopping.stopped) {
        return yield* Effect.fail(
          new AttemptConflict("Sandbox service is stopping. Retry after restart."),
        );
      }

      yield* Effect.try({
        try: () => validateBundles(request),
        catch: (cause) => (cause instanceof InvalidAttempt ? cause : failure("bundles", cause)),
      });
      const id = attemptId(this.config.stateRoot, request);

      return yield* this.withAdmission(id, this.admit(id, request));
    });
  }

  private plan(id: string, requestHash: string, request: SandboxAttemptRequest): DockerAttemptPlan {
    const spec = request.spec;

    const timeout =
      spec.kind === "code"
        ? spec.timeoutMs
        : (spec.node.options.timeout === undefined
            ? 300_000
            : durationMs(spec.node.options.timeout)) + (spec.parse ? 300_000 : 0);

    return {
      id,
      requestHash,
      workspace: request.workspace,
      executionKey: request.executionKey,
      attempt: request.attempt,
      ...attemptResourceNames(
        id,
        attemptHash(workspaceVolumeInput(this.config.stateRoot, request)),
      ),
      deadline: Date.now() + Math.min(timeout + 30_000, this.config.maxTimeoutMs),
    };
  }

  observe(record: AttemptRecord) {
    return Effect.gen({ self: this }, function* () {
      const retained = this.retained.get(record.plan.id);

      if (record.kind === "started") {
        yield* this.monitor(
          record,
          retained?.requestHash === record.plan.requestHash ? retained.request : undefined,
        );
      }

      this.retained.delete(record.plan.id);
    });
  }

  monitor(record: Extract<AttemptRecord, { kind: "started" }>, request?: SandboxAttemptRequest) {
    return Effect.gen({ self: this }, function* () {
      if (this.stopping.stopped) {
        return;
      }

      this.retained.delete(record.plan.id);

      if (this.monitors.has(record.plan.id)) {
        return;
      }

      const receipt = { ...record.plan, kind: "started" } as const;

      const sameSession =
        record.session.epoch === this.session.epoch && record.session.nonce === this.session.nonce;

      if (request && sameSession && !this.issued.has(record.plan.id)) {
        // Record issuance before forking so a later observation can only recover.
        this.issued.add(record.plan.id);
        yield* this.monitors.launch(record, () =>
          this.dependencies.backend.start(receipt, request, this.stopping.signal),
        );
      } else {
        yield* this.monitors.launch(record, () =>
          this.dependencies.backend.recover(receipt, this.stopping.signal),
        );
      }
    });
  }

  private publishAdmission(plan: DockerAttemptPlan, request: SandboxAttemptRequest) {
    return Effect.gen({ self: this }, function* () {
      const authority = this.dependencies.authority;
      const admitted = yield* authority.admit({ session: this.session, plan }).pipe(Effect.result);

      if (Result.isFailure(admitted)) {
        this.retained.set(plan.id, { request, requestHash: plan.requestHash });

        return yield* resolveAdmissionRead({
          authority,
          id: plan.id,
          stopping: this.stopping,
          cause: admitted.failure,
        });
      }

      const reply = admitted.success;

      if (reply.kind === "rejected") {
        return yield* Effect.fail(
          new AttemptConflict(`Attempt admission was rejected: ${reply.code}.`),
        );
      }

      return reply.record;
    });
  }

  private admit(id: string, request: SandboxAttemptRequest) {
    return Effect.gen({ self: this }, function* () {
      const authority = this.dependencies.authority;

      const requestHash = attemptHash({
        ...request,
        bundles: [...request.bundles].sort((a, b) => a.hash.localeCompare(b.hash)),
      });

      let record = yield* authority.read(id);

      if (record === null) {
        const plan = this.plan(id, requestHash, request);
        yield* this.exports.reconcile(plan.volume);

        if (this.stopping.stopped) {
          return yield* Effect.fail(new AttemptConflict("Sandbox service is stopping."));
        }

        record = yield* this.publishAdmission(plan, request);
      }

      if (record.plan.requestHash !== requestHash) {
        return yield* Effect.fail(
          new AttemptConflict("Attempt identity already has different request content."),
        );
      }

      if (record.kind === "started") {
        yield* this.monitor(record, request);
      }

      return yield* publicReceipt(this.dependencies.resultsFor, record);
    });
  }
}
