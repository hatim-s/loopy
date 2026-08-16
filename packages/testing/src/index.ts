import type {
  ApprovalRecord,
  AttemptRecord,
  JsonObject,
  ProviderExecutionContext,
  ProviderExecutor,
  ProviderResult,
  RunRecord,
  RuntimeEvent,
  RuntimeStore,
  RuntimeStoreCommand,
  VerificationContext,
  VerificationExecutor,
  VerificationResult,
} from "@loopy/runtime";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Deterministic conformance store. Production storage can implement this command port with SQLite. */
export class InMemoryRuntimeStore implements RuntimeStore {
  readonly runs = new Map<string, RunRecord>();
  readonly attempts = new Map<string, AttemptRecord>();
  readonly events = new Map<string, RuntimeEvent[]>();
  readonly approvals = new Map<string, ApprovalRecord>();
  async commit(commands: readonly RuntimeStoreCommand[]): Promise<void> {
    for (const command of commands) {
      if (command.type === "set_run" && !this.runs.has(command.runId))
        throw new Error(`Unknown run ${command.runId}`);
      if (command.type === "create_run" && this.runs.has(command.run.runId))
        throw new Error(`Duplicate run ${command.run.runId}`);
      if (command.type === "set_attempt" && !this.attempts.has(command.attemptId))
        throw new Error(`Unknown attempt ${command.attemptId}`);
      if (command.type === "create_attempt" && this.attempts.has(command.attempt.attemptId))
        throw new Error(`Duplicate attempt ${command.attempt.attemptId}`);
      if (
        command.type === "create_attempt" &&
        command.expectedRunStatus &&
        this.runs.get(command.attempt.runId)?.status !== command.expectedRunStatus
      )
        throw new Error(`Attempt run precondition failed for ${command.attempt.runId}`);
      if (command.type === "set_run" && command.patch.status) {
        const current = this.runs.get(command.runId)?.status;
        if (current && !legalRunTransition(current, command.patch.status))
          throw new Error(`Illegal run transition ${current} -> ${command.patch.status}`);
      }
      if (command.type === "set_attempt" && command.patch.status) {
        const current = this.attempts.get(command.attemptId)?.status;
        if (current && !legalAttemptTransition(current, command.patch.status))
          throw new Error(`Illegal attempt transition ${current} -> ${command.patch.status}`);
      }
      if (command.type === "set_attempt") {
        const attempt = this.attempts.get(command.attemptId);
        if (command.expectedStatus && attempt?.status !== command.expectedStatus)
          throw new Error(`Attempt status precondition failed for ${command.attemptId}`);
        if (
          command.expectedRunStatus &&
          (!attempt || this.runs.get(attempt.runId)?.status !== command.expectedRunStatus)
        )
          throw new Error(`Attempt run precondition failed for ${command.attemptId}`);
      }
      if (command.type === "resolve_approval") {
        const run = this.runs.get(command.runId);
        const approval = this.approvals.get(`${command.runId}:${command.nodeId}`);
        const attempt = command.attemptId ? this.attempts.get(command.attemptId) : undefined;
        if (!run || (command.expectedRunStatus && run.status !== command.expectedRunStatus))
          throw new Error(`Approval run precondition failed for ${command.runId}`);
        if (!approval || (command.expectedDecision === "pending" && approval.decision))
          throw new Error(
            `Approval decision precondition failed for ${command.runId}/${command.nodeId}`,
          );
        if (
          command.expectedAttemptStatus &&
          (!attempt || attempt.status !== command.expectedAttemptStatus)
        )
          throw new Error(
            `Approval attempt precondition failed for ${command.runId}/${command.nodeId}`,
          );
      }
    }
    for (const command of commands) {
      switch (command.type) {
        case "create_run":
          this.runs.set(command.run.runId, clone(command.run));
          break;
        case "set_run": {
          const run = this.runs.get(command.runId);
          if (run) this.runs.set(command.runId, { ...run, ...clone(command.patch) });
          break;
        }
        case "create_attempt":
          this.attempts.set(command.attempt.attemptId, clone(command.attempt));
          break;
        case "set_attempt": {
          const attempt = this.attempts.get(command.attemptId);
          if (attempt)
            this.attempts.set(command.attemptId, { ...attempt, ...clone(command.patch) });
          break;
        }
        case "set_approval":
          this.approvals.set(
            `${command.approval.runId}:${command.approval.nodeId}`,
            clone(command.approval),
          );
          break;
        case "resolve_approval": {
          const approval = this.approvals.get(`${command.runId}:${command.nodeId}`);
          if (approval)
            this.approvals.set(`${command.runId}:${command.nodeId}`, {
              ...approval,
              decision: command.decision,
            });
          break;
        }
        case "append_event": {
          const list = this.events.get(command.event.runId) ?? [];
          list.push({ ...clone(command.event), sequence: list.length });
          this.events.set(command.event.runId, list);
          break;
        }
      }
    }
  }
  async getRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(runId);
    return run ? clone(run) : undefined;
  }
  async listRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()].map(clone);
  }
  async listAttempts(runId: string): Promise<AttemptRecord[]> {
    return [...this.attempts.values()].filter((a) => a.runId === runId).map(clone);
  }
  async listEvents(runId: string): Promise<RuntimeEvent[]> {
    return clone(this.events.get(runId) ?? []);
  }
  async getApproval(runId: string, nodeId: string): Promise<ApprovalRecord | undefined> {
    const item = this.approvals.get(`${runId}:${nodeId}`);
    return item ? clone(item) : undefined;
  }
}

const RUN_TRANSITIONS: Record<string, readonly string[]> = {
  created: ["running", "cancelling"],
  running: ["pause_requested", "paused", "cancelling", "succeeded", "failed"],
  pause_requested: ["paused", "cancelling"],
  paused: ["running", "cancelling"],
  cancelling: ["cancelled", "failed"],
  cancelled: ["running"],
  succeeded: [],
  failed: ["running"],
};
const ATTEMPT_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["ready", "cancelled", "skipped"],
  ready: ["running", "cancelled", "skipped"],
  running: ["blocked_approval", "succeeded", "failed", "cancelled"],
  blocked_approval: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
};
function legalRunTransition(from: string, to: string): boolean {
  return from === to || RUN_TRANSITIONS[from]?.includes(to) === true;
}
function legalAttemptTransition(from: string, to: string): boolean {
  return from === to || ATTEMPT_TRANSITIONS[from]?.includes(to) === true;
}

export type FakeProviderStep =
  | ProviderResult
  | ((context: ProviderExecutionContext) => ProviderResult | Promise<ProviderResult>);

/** A deterministic fake provider with scripted results and explicit deferred steps. */
export class DeterministicFakeProvider implements ProviderExecutor {
  readonly calls: ProviderExecutionContext[] = [];
  readonly cancelled = new Set<string>();
  private readonly scripts = new Map<string, FakeProviderStep[]>();
  private readonly deferred = new Map<
    string,
    { resolve: (result: ProviderResult) => void; reject: (error: unknown) => void }
  >();
  set(nodeId: string, ...steps: FakeProviderStep[]): this {
    this.scripts.set(nodeId, [...steps]);
    return this;
  }
  succeed(nodeId: string, outputs: JsonObject = {}, summary = "Fake provider succeeded"): this {
    return this.set(nodeId, { status: "succeeded", outputs, summary });
  }
  fail(nodeId: string, error = "Fake provider failed"): this {
    return this.set(nodeId, { status: "failed", error });
  }
  defer(nodeId: string): this {
    return this.set(
      nodeId,
      async (context) =>
        new Promise<ProviderResult>((resolve, reject) =>
          this.deferred.set(context.attemptId, { resolve, reject }),
        ),
    );
  }
  release(
    attemptId: string,
    result: ProviderResult = {
      status: "succeeded",
      outputs: {},
      summary: "Fake provider succeeded",
    },
  ): void {
    this.deferred.get(attemptId)?.resolve(result);
    this.deferred.delete(attemptId);
  }
  async execute(context: ProviderExecutionContext): Promise<ProviderResult> {
    this.calls.push(context);
    const script = this.scripts.get(context.nodeId) ?? [
      { status: "succeeded", outputs: {}, summary: "Fake provider succeeded" },
    ];
    const step = script.length > 1 ? (script.shift() as FakeProviderStep) : script[0];
    if (typeof step === "function") return step(context);
    return clone(step ?? { status: "succeeded", outputs: {}, summary: "Fake provider succeeded" });
  }
  cancel(attemptId: string): void {
    this.cancelled.add(attemptId);
    this.deferred.get(attemptId)?.resolve({ status: "cancelled", error: "cancelled by user" });
    this.deferred.delete(attemptId);
  }
}

export class DeterministicVerifier implements VerificationExecutor {
  readonly calls: VerificationContext[] = [];
  private readonly results = new Map<string, VerificationResult[]>();
  set(nodeId: string, ...results: VerificationResult[]): this {
    this.results.set(nodeId, [...results]);
    return this;
  }
  pass(nodeId: string, summary = "Verification passed"): this {
    return this.set(nodeId, { status: "passed", summary });
  }
  fail(nodeId: string, summary = "Verification failed"): this {
    return this.set(nodeId, { status: "failed", summary });
  }
  async verify(context: VerificationContext): Promise<VerificationResult> {
    this.calls.push(context);
    const values = this.results.get(context.nodeId) ?? [
      { status: "passed", summary: "Verification passed" },
    ];
    return clone(
      (values.length > 1 ? values.shift() : values[0]) ?? {
        status: "passed",
        summary: "Verification passed",
      },
    );
  }
}

export function createTestIds(): () => string {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}
