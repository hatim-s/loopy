import { setTimeout as delay } from "node:timers/promises";
import type { SandboxExecutionResult } from "../../../packages/loopy/src/contract/index.js";
import {
  type AttemptRecord,
  AuthorityError,
  type AuthoritySession,
  type ResultsFor,
} from "../../../packages/loopy/src/contract/sandbox-journal.js";
import type { SandboxAttemptAuthority } from "../../../packages/loopy/src/contract/sandbox-journal-rpc.js";
import type { AttemptBackend } from "./docker.js";
import { boundedResult } from "./result.js";

export async function pause(backoffMs: number, signal: AbortSignal) {
  try {
    await delay(backoffMs, undefined, { signal });

    return !signal.aborted;
  } catch {
    return false;
  }
}

export class AttemptMonitors {
  private readonly active = new Map<string, Promise<void>>();
  private readonly authority: SandboxAttemptAuthority;
  private readonly resultsFor: ResultsFor;
  private readonly backend: AttemptBackend;
  private readonly session: AuthoritySession;
  private readonly signal: AbortSignal;
  constructor(options: {
    authority: SandboxAttemptAuthority;
    resultsFor: ResultsFor;
    backend: AttemptBackend;
    session: AuthoritySession;
    signal: AbortSignal;
  }) {
    this.authority = options.authority;
    this.resultsFor = options.resultsFor;
    this.backend = options.backend;
    this.session = options.session;
    this.signal = options.signal;
  }

  has(id: string) {
    return this.active.has(id);
  }

  launch(
    record: Extract<AttemptRecord, { kind: "started" }>,
    perform: () => ReturnType<AttemptBackend["recover"]>,
  ) {
    if (this.active.has(record.plan.id) || this.signal.aborted) {
      return;
    }

    const operation = this.monitor(record, perform);
    this.active.set(record.plan.id, operation);
    void operation.then(() => this.active.delete(record.plan.id));
  }

  private async monitor(
    record: Extract<AttemptRecord, { kind: "started" }>,
    perform: () => ReturnType<AttemptBackend["recover"]>,
  ) {
    const receipt = { ...record.plan, kind: "started" } as const;
    let observed: SandboxExecutionResult | null = null;
    let backoff = 100;
    let reconcile = perform;

    while (!this.signal.aborted) {
      try {
        observed ??= boundedResult(await reconcile());

        if (this.signal.aborted) {
          return;
        }

        const result = await this.resultsFor(record.plan.workspace).put(observed);

        if (this.signal.aborted) {
          return;
        }

        const completed = await this.authority.complete({
          session: this.session,
          id: record.plan.id,
          requestHash: record.plan.requestHash,
          result,
        });

        if (completed.kind === "rejected") {
          throw new AuthorityError(completed.code);
        }

        return;
      } catch {
        // Once observed, a terminal result survives publication failure without another Docker read.
        reconcile = () => this.backend.recover(receipt, this.signal);

        if (!(await pause(backoff, this.signal))) {
          return;
        }

        backoff = Math.min(backoff * 2, 5000);
      }
    }
  }

  async drain() {
    await Promise.all(this.active.values());
  }
}
