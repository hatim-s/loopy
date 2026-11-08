import { randomUUID } from "node:crypto";
import {
  type AuthoritySession,
  attemptId,
  type SandboxArtifactRequest,
  type SandboxAttemptIdentity,
  type SandboxAttemptRequest,
} from "@loopy/contract/sandbox";
import { acquirePidLock } from "@loopy/runtime/os";
import { Cause, Effect, Exit, Fiber, FiberMap, FiberSet, Scope } from "effect";
import type { SandboxConfig } from "../config";
import { checked, io, type SandboxFailure, type SandboxOperationError } from "../operations";
import { publicReceipt } from "../receipt-view";
import { SandboxRequestError } from "../request-error";
import { closeableScope } from "../scope";
import { stateLayout, validateStateRoot } from "../state-root";
import { Stopping, stoppingConflict } from "../stopping";
import { AttemptAdmissions } from "./admissions";
import type { AttemptDependencies, AttemptDependenciesFactory } from "./dependencies";
import { AttemptExports, recoveryRecords } from "./exports";
import { AttemptMonitors } from "./monitor";

type AttemptsOptions = {
  config: SandboxConfig;
  dependencies: AttemptDependencies;
  session: AuthoritySession;
  scope: Scope.Closeable;
  close: Effect.Effect<void, SandboxOperationError>;
  stopping: Stopping;
  operations: FiberSet.FiberSet<unknown, SandboxFailure>;
  active: FiberMap.FiberMap<string, void, never>;
  evictions: FiberMap.FiberMap<string, void, never>;
};

export class Attempts {
  private readonly admissions: AttemptAdmissions;
  private readonly monitors: AttemptMonitors;
  private readonly exports: AttemptExports;
  private constructor(private readonly options: AttemptsOptions) {
    const { config, dependencies, session, stopping, active, evictions } = options;
    this.monitors = new AttemptMonitors({ ...dependencies, session, stopping, active });
    this.exports = new AttemptExports(dependencies.authority, dependencies.artifactReader, session);
    this.admissions = new AttemptAdmissions({
      config,
      dependencies,
      session,
      monitors: this.monitors,
      exports: this.exports,
      stopping,
      evictions,
    });
  }
  static open(config: SandboxConfig, createDependencies: AttemptDependenciesFactory) {
    return closeableScope(
      {
        operation: "resource release",
        message: "Sandbox resource release failed. Inspect the state root before restarting.",
      },
      (close) =>
        Effect.gen(function* () {
          yield* io("state root", () => validateStateRoot(config));
          yield* Effect.acquireRelease(
            checked("lock", () => acquirePidLock(stateLayout(config.stateRoot).lock)),
            (unlock) => checked("unlock", unlock).pipe(Effect.orDie),
          );

          const dependencies = yield* Effect.acquireRelease(createDependencies(), (value) =>
            (value.close?.() ?? Effect.void).pipe(Effect.orDie),
          );

          const { epoch } = yield* dependencies.authority.status({});

          const session = yield* dependencies.authority.openSession({
            expectedEpoch: epoch,
            nonce: randomUUID(),
          });

          const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void),
          );

          const [operations, active, evictions] = yield* Effect.all([
            FiberSet.make<unknown, SandboxFailure>(),
            FiberMap.make<string, void, never>(),
            FiberMap.make<string, void, never>(),
          ]).pipe(Effect.provideService(Scope.Scope, scope));

          const attempts = new Attempts({
            config,
            dependencies,
            session,
            scope,
            close,
            stopping: yield* Stopping.make(),
            operations,
            active,
            evictions,
          });

          yield* Effect.addFinalizer(() => attempts.stopWork());
          const recovered = yield* recoveryRecords(dependencies.authority);
          yield* attempts.exports.reconcileGuards(recovered.exports);

          for (const record of recovered.attempts) {
            yield* attempts.admissions.monitor(record);
          }

          return attempts;
        }),
    );
  }
  private supervise<A>(
    operation: Effect.Effect<A, SandboxFailure>,
  ): Effect.Effect<A, SandboxFailure> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        const { stopping, operations } = this.options;

        if (stopping.stopped) {
          return yield* Effect.fail(stoppingConflict());
        }

        const fiber = yield* FiberSet.run(operations, operation);

        return yield* restore(Fiber.join(fiber)).pipe(
          Effect.catchCause((cause) =>
            stopping.stopped && cause.reasons.every(Cause.isInterruptReason)
              ? Effect.fail(stoppingConflict())
              : Effect.failCause(cause),
          ),
        );
      }),
    );
  }
  lookup(identity: SandboxAttemptIdentity) {
    return this.supervise(
      Effect.gen({ self: this }, function* () {
        const { config, dependencies } = this.options;
        const id = yield* Effect.promise(() => attemptId(config.stateRoot, identity));
        yield* this.admissions.wait(id);

        if (this.monitors.has(id)) {
          return { kind: "started" } as const;
        }

        const record = yield* dependencies.authority.read({ id });

        if (record) {
          yield* this.admissions.observe(record);
        }

        return yield* publicReceipt(dependencies.resultsFor, record);
      }),
    );
  }
  start(request: SandboxAttemptRequest) {
    return this.supervise(this.admissions.start(request));
  }
  artifact(request: SandboxArtifactRequest) {
    return this.supervise(
      Effect.gen({ self: this }, function* () {
        const { config, dependencies } = this.options;
        const id = yield* Effect.promise(() => attemptId(config.stateRoot, request));
        yield* this.admissions.wait(id);
        const record = yield* dependencies.authority.read({ id });

        if (!record) {
          return yield* Effect.fail(
            new SandboxRequestError("not_found", "Artifact attempt receipt was not found."),
          );
        }

        if (record.kind !== "finished") {
          return yield* Effect.fail(
            new SandboxRequestError("conflict", "Artifact export requires a finished attempt."),
          );
        }

        return yield* this.exports.read(record, request);
      }),
    );
  }
  drain() {
    return this.monitors.drain();
  }
  close() {
    return Effect.uninterruptible(this.options.close);
  }
  private stopWork() {
    return Effect.gen({ self: this }, function* () {
      const { stopping, operations, scope } = this.options;
      yield* stopping.stop();
      yield* FiberSet.awaitEmpty(operations);
      yield* this.drain();
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.uninterruptible);
  }
}
