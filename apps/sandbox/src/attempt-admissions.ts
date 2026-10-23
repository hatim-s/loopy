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
import { AttemptConflict, attemptHash, attemptId, validateBundles } from "./admission.js";
import type { AttemptDependencies } from "./attempt-dependencies.js";
import type { AttemptExports } from "./attempt-exports.js";
import type { AttemptMonitors } from "./attempt-monitor.js";
import { resolveAdmissionRead } from "./attempt-reconciliation.js";
import type { SandboxConfig } from "./config.js";

export class AttemptAdmissions {
  private readonly admissions = new Map<string, Promise<SandboxReceipt>>();
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
  private readonly signal: AbortSignal;
  private readonly publicReceipt: (record: AttemptRecord | null) => Promise<SandboxReceipt>;
  constructor(options: {
    config: SandboxConfig;
    dependencies: AttemptDependencies;
    session: AuthoritySession;
    monitors: AttemptMonitors;
    exports: AttemptExports;
    signal: AbortSignal;
    publicReceipt: (record: AttemptRecord | null) => Promise<SandboxReceipt>;
  }) {
    this.config = options.config;
    this.dependencies = options.dependencies;
    this.session = options.session;
    this.monitors = options.monitors;
    this.exports = options.exports;
    this.signal = options.signal;
    this.publicReceipt = options.publicReceipt;
  }

  async wait(id: string) {
    await this.admissions.get(id);
  }
  async settle() {
    await Promise.allSettled(this.admissions.values());
  }

  async start(request: SandboxAttemptRequest): Promise<SandboxReceipt> {
    if (this.signal.aborted) {
      throw new AttemptConflict("Sandbox service is stopping. Retry after restart.");
    }

    validateBundles(request);
    const id = attemptId(this.config.stateRoot, request);
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
    const retained = this.retained.get(record.plan.id);

    if (record.kind === "started") {
      this.monitor(
        record,
        retained?.requestHash === record.plan.requestHash ? retained.request : undefined,
      );
    }

    this.retained.delete(record.plan.id);
  }

  monitor(record: Extract<AttemptRecord, { kind: "started" }>, request?: SandboxAttemptRequest) {
    if (this.signal.aborted) {
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
      // Set before invoking start, including synchronous backend callbacks and thrown calls.
      this.issued.add(record.plan.id);
      this.monitors.launch(record, () =>
        this.dependencies.backend.start(receipt, request, this.signal),
      );
    } else {
      this.monitors.launch(record, () => this.dependencies.backend.recover(receipt, this.signal));
    }
  }

  private async publishAdmission(plan: DockerAttemptPlan, request: SandboxAttemptRequest) {
    const authority = this.dependencies.authority;
    let reply;

    try {
      reply = await authority.admit({ session: this.session, plan });
    } catch (cause) {
      // A null resolving read may precede a delayed remote commit. Lookup keeps this obligation.
      this.retained.set(plan.id, { request, requestHash: plan.requestHash });

      return resolveAdmissionRead({
        authority,
        id: plan.id,
        signal: this.signal,
        cause: cause instanceof Error ? cause : new Error("Admission response failed.", { cause }),
      });
    }

    if (reply.kind === "rejected") {
      throw new AttemptConflict(`Attempt admission was rejected: ${reply.code}.`);
    }

    return reply.record;
  }

  private async admit(id: string, request: SandboxAttemptRequest): Promise<SandboxReceipt> {
    const authority = this.dependencies.authority;

    const requestHash = attemptHash({
      ...request,
      bundles: [...request.bundles].sort((a, b) => a.hash.localeCompare(b.hash)),
    });

    let record = await authority.read(id);

    if (record === null) {
      const plan = this.plan(id, requestHash, request);
      await this.exports.reconcile(plan.volume);

      if (this.signal.aborted) {
        throw new AttemptConflict("Sandbox service is stopping.");
      }

      record = await this.publishAdmission(plan, request);
    }

    if (record.plan.requestHash !== requestHash) {
      throw new AttemptConflict("Attempt identity already has different request content.");
    }

    if (record.kind === "started") {
      this.monitor(record, request);
    }

    return this.publicReceipt(record);
  }
}
