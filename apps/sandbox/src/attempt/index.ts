import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, Fiber, FiberMap, FiberSet, Scope } from "effect";
import type {
  SandboxArtifactRequest,
  SandboxAttemptIdentity,
  SandboxAttemptRequest,
} from "../../../../packages/loopy/src/contract";
import type { AuthoritySession } from "../../../../packages/loopy/src/contract/sandbox-journal";
import { attemptId } from "../admission";
import { ArtifactError } from "../artifact-error";
import { type SandboxConfig, validateStateRoot } from "../config";
import { failure, io, type SandboxFailure } from "../operations";
import { publicReceipt } from "../receipt-view";
import { lockStateRoot } from "../receipts";
import { Stopping } from "../stopping";
import { AttemptAdmissions } from "./admissions";
import type { AttemptDependencies, AttemptDependenciesFactory } from "./dependencies";
import { AttemptExports, recoveryRecords } from "./exports";
import { AttemptMonitors } from "./monitor";

export { AttemptConflict } from "../admission";

export class Attempts {
  private readonly admissions: AttemptAdmissions;
  private readonly monitors: AttemptMonitors;
  private readonly exports: AttemptExports;
  private constructor(
    private readonly config: SandboxConfig,
    private readonly dependencies: AttemptDependencies,
    session: AuthoritySession,
    private readonly scope: Scope.Closeable,
    private readonly closeResources: Effect.Effect<void, SandboxFailure>,
    private readonly stopping: Stopping,
    private readonly operations: FiberSet.FiberSet<unknown, SandboxFailure>,
    active: FiberMap.FiberMap<string, void, never>,
  ) {
    this.monitors = new AttemptMonitors({
      ...dependencies,
      session,
      stopping,
      active,
    });
    this.exports = new AttemptExports(dependencies.authority, dependencies.artifactReader, session);
    this.admissions = new AttemptAdmissions({
      config,
      dependencies,
      session,
      monitors: this.monitors,
      exports: this.exports,
      stopping,
    });
  }
  static open(config: SandboxConfig, createDependencies: AttemptDependenciesFactory) {
    return Effect.gen(function* () {
      const resources = yield* Scope.make();

      const closeResources = yield* Effect.cached(
        Scope.close(resources, Exit.void).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              failure(
                "resource release",
                cause,
                "Sandbox resource release failed. Inspect the state root before restarting.",
              ),
            ),
          ),
          Effect.uninterruptible,
        ),
      );

      yield* Effect.addFinalizer(() => closeResources.pipe(Effect.orDie));

      return yield* Effect.gen(function* () {
        yield* io("state root", () => validateStateRoot(config));
        yield* Effect.acquireRelease(
          io("lock", () => lockStateRoot(config.stateRoot)),
          (unlock) => io("unlock", unlock).pipe(Effect.orDie),
        );

        const dependencies = yield* Effect.acquireRelease(createDependencies(), (value) =>
          (value.close?.() ?? Effect.void).pipe(Effect.orDie),
        );

        const { epoch } = yield* dependencies.authority.status();

        const session = yield* dependencies.authority.openSession({
          expectedEpoch: epoch,
          nonce: randomUUID(),
        });

        const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );

        const operations = yield* FiberSet.make<unknown, SandboxFailure>().pipe(
          Effect.provideService(Scope.Scope, scope),
        );

        const active = yield* FiberMap.make<string, void, never>().pipe(
          Effect.provideService(Scope.Scope, scope),
        );

        const stopping = yield* Stopping.make();

        const attempts = new Attempts(
          config,
          dependencies,
          session,
          scope,
          closeResources,
          stopping,
          operations,
          active,
        );

        yield* Effect.addFinalizer(() => attempts.stopWork());
        const recovered = yield* recoveryRecords(dependencies.authority);
        yield* attempts.exports.reconcileGuards(recovered.exports);

        for (const record of recovered.attempts) {
          yield* attempts.admissions.monitor(record);
        }

        return attempts;
      }).pipe(
        Effect.provideService(Scope.Scope, resources),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? closeResources.pipe(Effect.orDie) : Effect.void,
        ),
      );
    });
  }
  private supervise<A>(
    operation: Effect.Effect<A, SandboxFailure>,
  ): Effect.Effect<A, SandboxFailure> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        if (this.stopping.stopped) {
          return yield* Effect.fail(
            new ArtifactError("conflict", "Sandbox service is stopping. Retry after restart."),
          );
        }

        const fiber = yield* FiberSet.run(this.operations, operation);

        return yield* restore(Fiber.join(fiber)).pipe(
          Effect.catchCause((cause) => {
            if (this.stopping.stopped && cause.reasons.every(Cause.isInterruptReason)) {
              return Effect.fail(
                new ArtifactError("conflict", "Sandbox service is stopping. Retry after restart."),
              );
            }

            return Effect.failCause(cause);
          }),
        );
      }),
    );
  }
  lookup(identity: SandboxAttemptIdentity) {
    return this.supervise(
      Effect.gen({ self: this }, function* () {
        const id = attemptId(this.config.stateRoot, identity);
        yield* this.admissions.wait(id);

        if (this.monitors.has(id)) {
          return { kind: "started" } as const;
        }

        const record = yield* this.dependencies.authority.read(id);

        if (record) {
          yield* this.admissions.observe(record);
        }

        return yield* publicReceipt(this.dependencies.resultsFor, record);
      }),
    );
  }
  start(request: SandboxAttemptRequest) {
    return this.supervise(this.admissions.start(request));
  }
  artifact(request: SandboxArtifactRequest) {
    return this.supervise(
      Effect.gen({ self: this }, function* () {
        const id = attemptId(this.config.stateRoot, request);
        yield* this.admissions.wait(id);
        const record = yield* this.dependencies.authority.read(id);

        if (!record) {
          return yield* Effect.fail(
            new ArtifactError("not_found", "Artifact attempt receipt was not found."),
          );
        }

        if (record.kind !== "finished") {
          return yield* Effect.fail(
            new ArtifactError("conflict", "Artifact export requires a finished attempt."),
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
    return Effect.uninterruptible(this.closeResources);
  }
  private stopWork() {
    return Effect.gen({ self: this }, function* () {
      yield* this.stopping.stop();
      yield* FiberSet.awaitEmpty(this.operations);
      yield* this.drain();
      yield* Scope.close(this.scope, Exit.void);
    }).pipe(Effect.uninterruptible);
  }
}
