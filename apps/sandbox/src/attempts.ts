import { setTimeout as delay } from "node:timers/promises";
import {
  type SandboxArtifact,
  type SandboxArtifactRequest,
  type SandboxAttemptIdentity,
  type SandboxAttemptRequest,
  type SandboxReceipt,
} from "../../../packages/loopy/src/contract/index.js";
import { durationMs } from "../../../packages/loopy/src/core/index.js";
import { attemptHash, validateBundles } from "./admission.js";
import { ArtifactError } from "./artifact-error.js";
import { type ArtifactReader, DockerArtifacts } from "./artifacts.js";
import { type SandboxConfig, validateStateRoot } from "./config.js";
import { type AttemptBackend, DockerBackend } from "./docker.js";
import {
  lockStateRoot,
  ReceiptStore,
  type StartedReceipt,
  type StoredReceipt,
} from "./receipts.js";
import { boundedResult } from "./result.js";

export class AttemptConflict extends Error {}

function publicReceipt(receipt: StoredReceipt | null): SandboxReceipt {
  if (receipt === null) {
    return { kind: "none" };
  }

  return receipt.kind === "started"
    ? { kind: "started" }
    : { kind: "finished", result: receipt.result };
}

export class Attempts {
  private readonly store: ReceiptStore;
  private readonly active = new Map<string, Promise<void>>();
  private readonly artifactOperations = new Set<Promise<SandboxArtifact>>();
  private readonly artifactReads = new Set<string>();
  private readonly stopping = new AbortController();
  private readonly admissions = new Map<string, Promise<SandboxReceipt>>();
  private constructor(
    private readonly config: SandboxConfig,
    private readonly backend: AttemptBackend,
    private readonly unlock: () => Promise<void>,
    private readonly artifactReader: ArtifactReader,
  ) {
    this.store = new ReceiptStore(config.stateRoot);
  }

  static async open(
    config: SandboxConfig,
    backend: AttemptBackend = new DockerBackend(config),
    artifactReader: ArtifactReader = new DockerArtifacts(config),
  ) {
    await validateStateRoot(config);
    const unlock = await lockStateRoot(config.stateRoot);
    const attempts = new Attempts(config, backend, unlock, artifactReader);

    try {
      for (const receipt of await attempts.store.pending()) {
        attempts.launch(receipt, () => backend.recover(receipt, attempts.stopping.signal));
      }

      return attempts;
    } catch (cause) {
      await unlock();
      throw cause;
    }
  }

  private id(identity: SandboxAttemptIdentity) {
    return attemptHash({
      root: this.config.stateRoot,
      workspace: identity.workspace,
      executionKey: identity.executionKey,
      attempt: identity.attempt,
    });
  }

  async lookup(identity: SandboxAttemptIdentity) {
    const id = this.id(identity);
    const admission = this.admissions.get(id);

    if (admission) {
      await admission;
    }

    return publicReceipt(await this.store.read(id));
  }

  async start(request: SandboxAttemptRequest): Promise<SandboxReceipt> {
    if (this.stopping.signal.aborted) {
      throw new AttemptConflict("Sandbox service is stopping. Retry after restart.");
    }

    validateBundles(request);
    const id = this.id(request);
    // Serialise admission so two HTTP requests cannot both pass the missing-receipt check.
    const previous = this.admissions.get(id);

    if (previous) {
      await previous;

      return this.start(request);
    }

    const admission = this.admit(id, request);
    this.admissions.set(id, admission);

    try {
      return await admission;
    } finally {
      this.admissions.delete(id);
    }
  }

  private async admit(id: string, request: SandboxAttemptRequest): Promise<SandboxReceipt> {
    const requestHash = attemptHash({
      ...request,
      bundles: [...request.bundles].sort((a, b) => a.hash.localeCompare(b.hash)),
    });

    const existing = await this.store.read(id);

    if (existing !== null) {
      if (existing.requestHash !== requestHash) {
        throw new AttemptConflict("Attempt identity already has different request content.");
      }

      return publicReceipt(existing);
    }

    const spec = request.spec;

    const timeout =
      spec.kind === "code"
        ? spec.timeoutMs
        : (spec.node.options.timeout === undefined
            ? 300_000
            : durationMs(spec.node.options.timeout)) + (spec.parse ? 300_000 : 0);

    const receipt: StartedReceipt = {
      kind: "started",
      id,
      requestHash,
      workspace: request.workspace,
      executionKey: request.executionKey,
      attempt: request.attempt,
      container: `loopy-attempt-${id}`,
      inputVolume: `loopy-input-${id}`,
      volume: `loopy-workspace-${attemptHash({ root: this.config.stateRoot, workspace: request.workspace, runId: request.executionKey.runId })}`,
      deadline: Date.now() + Math.min(timeout + 30_000, this.config.maxTimeoutMs),
    };

    if (this.artifactReads.has(receipt.volume)) {
      throw new AttemptConflict(
        "Workspace artifact export is in progress. Retry admission after export.",
      );
    }

    await this.store.started(receipt);
    this.launch(receipt, () => this.backend.start(receipt, request, this.stopping.signal));

    return { kind: "started" };
  }

  async artifact(request: SandboxArtifactRequest) {
    if (this.stopping.signal.aborted) {
      throw new ArtifactError("conflict", "Sandbox service is stopping. Retry after restart.");
    }

    const operation = this.readArtifact(request);
    this.artifactOperations.add(operation);

    try {
      return await operation;
    } finally {
      this.artifactOperations.delete(operation);
    }
  }

  private async readArtifact(request: SandboxArtifactRequest) {
    const admission = this.admissions.get(this.id(request));

    if (admission) {
      await admission;
    }

    const receipt = await this.store.read(this.id(request));

    if (receipt === null) {
      throw new ArtifactError("not_found", "Artifact attempt receipt was not found.");
    }

    if (receipt.kind !== "finished" || this.artifactReads.has(receipt.volume)) {
      throw new ArtifactError(
        "conflict",
        "Artifact export requires a finished attempt and an idle workspace.",
      );
    }

    this.artifactReads.add(receipt.volume);

    try {
      // Fence new admission before checking already-admitted attempts sharing the volume.
      await Promise.allSettled(this.admissions.values());

      if ((await this.store.pending()).some((pending) => pending.volume === receipt.volume)) {
        throw new ArtifactError(
          "conflict",
          "Workspace still has a started attempt. Export after the run is terminal.",
        );
      }

      return await this.artifactReader.read(receipt, request.path);
    } finally {
      this.artifactReads.delete(receipt.volume);
    }
  }

  private launch(receipt: StartedReceipt, perform: () => ReturnType<AttemptBackend["recover"]>) {
    const operation = (async () => {
      let reconcile = perform;
      let backoffMs = 100;

      while (!this.stopping.signal.aborted) {
        try {
          const result = boundedResult(await reconcile());
          await this.store.finished(receipt, result);

          return;
        } catch {
          // Unknown Docker state stays started. Recovery only inspects the pinned container.
          reconcile = () => this.backend.recover(receipt, this.stopping.signal);

          try {
            await delay(backoffMs, undefined, { signal: this.stopping.signal });
          } catch {
            return;
          }

          backoffMs = Math.min(backoffMs * 2, 5000);
        }
      }
    })();

    this.active.set(receipt.id, operation);
    // Retain monitoring until terminal state is confirmed or shutdown leaves recovery to the next process.
    void operation.then(
      () => this.active.delete(receipt.id),
      () => undefined,
    );
  }

  async drain() {
    await Promise.all(this.active.values());
  }

  async close() {
    this.stopping.abort();

    try {
      await this.drain();
      await Promise.allSettled(this.artifactOperations);
    } finally {
      await this.unlock();
    }
  }
}
