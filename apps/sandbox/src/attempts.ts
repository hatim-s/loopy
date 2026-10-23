import { randomUUID } from "node:crypto";
import {
  type SandboxArtifact,
  type SandboxArtifactRequest,
  type SandboxAttemptIdentity,
  type SandboxAttemptRequest,
  type SandboxReceipt,
} from "../../../packages/loopy/src/contract/index.js";
import {
  type AttemptRecord,
  type AuthoritySession,
} from "../../../packages/loopy/src/contract/sandbox-journal.js";
import { attemptHash } from "./admission.js";
import { ArtifactError } from "./artifact-error.js";
import { AttemptAdmissions } from "./attempt-admissions.js";
import type { AttemptDependencies, AttemptDependenciesFactory } from "./attempt-dependencies.js";
import { AttemptExports, recoveryRecords } from "./attempt-exports.js";
import { AttemptMonitors } from "./attempt-monitor.js";
import { type SandboxConfig, validateStateRoot } from "./config.js";
import { lockStateRoot } from "./receipts.js";

export { AttemptConflict } from "./admission.js";

export class Attempts {
  private readonly artifactOperations = new Set<Promise<SandboxArtifact>>();
  private readonly stopping = new AbortController();
  private readonly admissions: AttemptAdmissions;
  private readonly monitors: AttemptMonitors;
  private readonly exports: AttemptExports;
  private closing: Promise<void> | null = null;

  private readonly config: SandboxConfig;
  private readonly dependencies: AttemptDependencies;
  private readonly unlock: () => Promise<void>;
  private constructor(options: {
    config: SandboxConfig;
    dependencies: AttemptDependencies;
    session: AuthoritySession;
    unlock: () => Promise<void>;
  }) {
    const { config, dependencies, session, unlock } = options;
    this.config = config;
    this.dependencies = dependencies;
    this.unlock = unlock;
    this.monitors = new AttemptMonitors({
      authority: dependencies.authority,
      resultsFor: dependencies.resultsFor,
      backend: dependencies.backend,
      session,
      signal: this.stopping.signal,
    });
    this.exports = new AttemptExports(dependencies.authority, dependencies.artifactReader, session);
    this.admissions = new AttemptAdmissions({
      config,
      dependencies,
      session,
      monitors: this.monitors,
      exports: this.exports,
      signal: this.stopping.signal,
      publicReceipt: (record) => this.publicReceipt(record),
    });
  }

  static async open(config: SandboxConfig, createDependencies: AttemptDependenciesFactory) {
    await validateStateRoot(config);
    const unlock = await lockStateRoot(config.stateRoot);
    let dependencies: AttemptDependencies | undefined;

    try {
      dependencies = await createDependencies();
      const authority = dependencies.authority;
      const { epoch } = await authority.status();
      const session = await authority.openSession({ expectedEpoch: epoch, nonce: randomUUID() });
      const attempts = new Attempts({ config, dependencies, session, unlock });
      await attempts.exports.reconcile();

      for (const record of (await recoveryRecords(authority)).attempts) {
        attempts.admissions.recover(record);
      }

      return attempts;
    } catch (cause) {
      await dependencies?.close?.();
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

  private async publicReceipt(record: AttemptRecord | null): Promise<SandboxReceipt> {
    if (record === null) {
      return { kind: "none" };
    }

    if (record.kind === "started") {
      return { kind: "started" };
    }

    const result =
      record.result.kind === "inline"
        ? record.result.value
        : await this.dependencies.resultsFor(record.plan.workspace).get(record.result.ref);

    return { kind: "finished", result };
  }

  async lookup(identity: SandboxAttemptIdentity) {
    const id = this.id(identity);
    await this.admissions.wait(id);

    // Only authoritative started records enter the monitor map.
    if (this.monitors.has(id)) {
      return { kind: "started" } as const;
    }

    const record = await this.dependencies.authority.read(id);

    if (record) {
      this.admissions.observe(record);
    }

    return this.publicReceipt(record);
  }

  start(request: SandboxAttemptRequest) {
    return this.admissions.start(request);
  }

  async artifact(request: SandboxArtifactRequest) {
    if (this.stopping.signal.aborted) {
      throw new ArtifactError("conflict", "Sandbox service is stopping. Retry after restart.");
    }

    const operation = (async () => {
      await this.admissions.wait(this.id(request));
      const record = await this.dependencies.authority.read(this.id(request));

      if (!record) {
        throw new ArtifactError("not_found", "Artifact attempt receipt was not found.");
      }

      if (record.kind !== "finished") {
        throw new ArtifactError("conflict", "Artifact export requires a finished attempt.");
      }

      const receipt = await this.publicReceipt(record);

      if (receipt.kind !== "finished") {
        throw new ArtifactError("conflict", "Artifact attempt is not terminal.");
      }

      return this.exports.read(record, receipt.result, request);
    })();

    this.artifactOperations.add(operation);

    try {
      return await operation;
    } finally {
      this.artifactOperations.delete(operation);
    }
  }

  async drain() {
    await this.monitors.drain();
  }

  close() {
    this.closing ??= this.shutdown();

    return this.closing;
  }

  private async shutdown() {
    this.stopping.abort();

    try {
      await this.admissions.settle();
      await this.drain();
      await Promise.allSettled(this.artifactOperations);
      await this.dependencies.close?.();
    } finally {
      await this.unlock();
    }
  }
}
