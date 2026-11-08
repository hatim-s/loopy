import type { Receipt } from "@loopy/contract";
import {
  type AttemptRecord,
  type AttemptResources,
  type AuthoritySession,
  attemptId,
  attemptRequestHash,
  attemptResources,
  type DockerAttemptPlan,
  type SandboxAttemptRequest,
} from "@loopy/contract/sandbox";
import { attemptBudgetMs } from "@loopy/core";
import { Clock, Effect, FiberMap, Result, Semaphore } from "effect";
import { validateBundles } from "../admission";
import type { SandboxConfig } from "../config";
import type { SandboxFailure } from "../operations";
import { publicReceipt } from "../receipt-view";
import { SandboxRequestError } from "../request-error";
import { type Stopping, stoppingConflict } from "../stopping";
import type { AttemptDependencies } from "./dependencies";
import type { AttemptExports } from "./exports";
import type { AttemptMonitors } from "./monitor";

type AdmissionOptions = {
  config: SandboxConfig;
  dependencies: AttemptDependencies;
  session: AuthoritySession;
  monitors: AttemptMonitors;
  exports: AttemptExports;
  stopping: Stopping;
  evictions: FiberMap.FiberMap<string, void, never>;
};

export class AttemptAdmissions {
  private readonly admissions = new Map<string, { mutex: Semaphore.Semaphore; users: number }>();
  // Never clear issued ids: a stale started read can arrive after terminal publication.
  private readonly issued = new Set<string>();
  private readonly retained = new Map<
    string,
    { request: SandboxAttemptRequest; requestHash: string }
  >();
  constructor(private readonly options: AdmissionOptions) {}

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
  start(request: SandboxAttemptRequest): Effect.Effect<Receipt, SandboxFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* validateBundles(request);
      const id = yield* Effect.promise(() => attemptId(this.options.config.stateRoot, request));

      return yield* this.withAdmission(id, this.admit(id, request));
    });
  }

  private plan(
    resources: AttemptResources,
    requestHash: string,
    request: SandboxAttemptRequest,
  ): Effect.Effect<DockerAttemptPlan> {
    const budget = Math.min(attemptBudgetMs(request.spec), this.options.config.maxTimeoutMs);

    return Effect.map(Clock.currentTimeMillis, (now) => ({
      ...resources,
      requestHash,
      workspace: request.workspace,
      executionKey: request.executionKey,
      attempt: request.attempt,
      deadline: now + budget,
    }));
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
      const { dependencies, monitors, session, stopping } = this.options;

      if (stopping.stopped) {
        return;
      }

      this.retained.delete(record.plan.id);

      const sameSession =
        record.session.epoch === session.epoch && record.session.nonce === session.nonce;

      if (request && sameSession && !this.issued.has(record.plan.id)) {
        this.issued.add(record.plan.id);
        yield* monitors.launch(record, () =>
          dependencies.backend.start(record.plan, request, stopping.signal),
        );
      } else {
        yield* monitors.launch(record, () =>
          dependencies.backend.recover(record.plan, stopping.signal),
        );
      }
    });
  }

  // An admission whose commit is delayed can still start once on a later lookup. Its request
  // stays retained only until the plan deadline, after which a start could no longer run.
  private retain(plan: DockerAttemptPlan, request: SandboxAttemptRequest) {
    return Effect.gen({ self: this }, function* () {
      this.retained.set(plan.id, { request, requestHash: plan.requestHash });

      yield* FiberMap.run(
        this.options.evictions,
        plan.id,
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Effect.sleep(Math.max(0, plan.deadline - now))),
          Effect.andThen(
            Effect.sync(() => {
              this.retained.delete(plan.id);
            }),
          ),
        ),
      );
    });
  }

  private publishAdmission(plan: DockerAttemptPlan, request: SandboxAttemptRequest) {
    return Effect.gen({ self: this }, function* () {
      const { dependencies, session, stopping } = this.options;
      const authority = dependencies.authority;
      const admitted = yield* authority.admit({ session, plan }).pipe(Effect.result);

      if (Result.isFailure(admitted)) {
        yield* this.retain(plan, request);
        const record = yield* stopping.retry(authority.read({ id: plan.id }));

        if (record === null) {
          return yield* Effect.fail(admitted.failure);
        }

        return record;
      }

      const reply = admitted.success;

      if (reply.kind === "rejected") {
        return yield* Effect.fail(
          new SandboxRequestError("conflict", `Attempt admission was rejected: ${reply.code}.`),
        );
      }

      return reply.record;
    });
  }

  private admit(id: string, request: SandboxAttemptRequest) {
    return Effect.gen({ self: this }, function* () {
      const { dependencies, exports, stopping } = this.options;

      const requestHash = yield* Effect.promise(() => attemptRequestHash(request));
      let record = yield* dependencies.authority.read({ id });

      if (record === null) {
        const resources = yield* Effect.promise(() =>
          attemptResources(this.options.config.stateRoot, request),
        );

        const plan = yield* this.plan(resources, requestHash, request);
        yield* exports.reconcile(plan.volume);

        if (stopping.stopped) {
          return yield* Effect.fail(stoppingConflict());
        }

        record = yield* this.publishAdmission(plan, request);
      }

      if (record.plan.requestHash !== requestHash) {
        return yield* Effect.fail(
          new SandboxRequestError(
            "conflict",
            "Attempt identity already has different request content.",
          ),
        );
      }

      if (record.kind === "started") {
        yield* this.monitor(record, request);
      }

      return yield* publicReceipt(dependencies.resultsFor, record);
    });
  }
}
