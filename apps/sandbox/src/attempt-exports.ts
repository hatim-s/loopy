import { randomUUID } from "node:crypto";
import type {
  SandboxArtifactRequest,
  SandboxExecutionResult,
} from "../../../packages/loopy/src/contract/index.js";
import type {
  AttemptRecord,
  AuthoritySession,
  ExportRecord,
} from "../../../packages/loopy/src/contract/sandbox-journal.js";
import type { SandboxAttemptAuthority } from "../../../packages/loopy/src/contract/sandbox-journal-rpc.js";
import { ArtifactError } from "./artifact-error.js";
import type { ArtifactReader } from "./artifacts.js";

export async function recoveryRecords(authority: SandboxAttemptAuthority) {
  const attempts: Extract<AttemptRecord, { kind: "started" }>[] = [];
  const exports: ExportRecord[] = [];
  let after: string | null = null;

  do {
    const page = await authority.recoverable({ after, limit: 200 });
    attempts.push(...page.attempts);
    exports.push(...page.exports);
    after = page.next;
  } while (after !== null);

  return { attempts, exports };
}

export class AttemptExports {
  private readonly live = new Set<string>();
  private readonly reconciliation = new Map<string, Promise<void>>();
  constructor(
    private readonly authority: SandboxAttemptAuthority,
    private readonly reader: ArtifactReader,
    private readonly session: AuthoritySession,
  ) {}

  private async release(guard: ExportRecord) {
    const record = await this.authority.read(guard.attemptId);

    if (
      !record ||
      record.plan.volume !== guard.volume ||
      guard.helper !== `loopy-artifact-${record.plan.id}`
    ) {
      throw new ArtifactError(
        "conflict",
        "Export guard does not match its attempt. Inspect durable state.",
      );
    }

    await this.reader.cleanup(record.plan, guard.helper);
    await this.authority.endExport({ session: this.session, token: guard.token });
  }

  async reconcile(volume?: string) {
    const { exports } = await recoveryRecords(this.authority);
    let blocked = false;

    for (const guard of exports) {
      if (volume !== undefined && guard.volume !== volume) {
        continue;
      }

      if (this.live.has(guard.token)) {
        blocked = true;
        continue;
      }

      let operation = this.reconciliation.get(guard.token);

      if (!operation) {
        operation = this.release(guard);
        this.reconciliation.set(guard.token, operation);
      }

      try {
        await operation;
      } catch {
        blocked = true;
      } finally {
        this.reconciliation.delete(guard.token);
      }
    }

    if (blocked && volume !== undefined) {
      throw new ArtifactError(
        "conflict",
        "Workspace export cleanup is unresolved. Retry after reconciliation.",
      );
    }
  }

  async read(
    record: Extract<AttemptRecord, { kind: "finished" }>,
    result: SandboxExecutionResult,
    request: SandboxArtifactRequest,
  ) {
    await this.reconcile(record.plan.volume);
    const token = randomUUID();
    this.live.add(token);

    try {
      const reply = await this.authority.beginExport({
        session: this.session,
        attemptId: record.plan.id,
        token,
      });

      if (reply.kind === "rejected") {
        throw new ArtifactError("conflict", `Workspace export was rejected: ${reply.code}.`);
      }

      try {
        return await this.reader.read({ ...record.plan, kind: "finished", result }, request.path);
      } finally {
        try {
          await this.release(reply.record);
        } catch {
          throw new ArtifactError(
            "conflict",
            "Workspace export cleanup is unresolved. Retry after reconciliation.",
          );
        }
      }
    } finally {
      this.live.delete(token);
    }
  }
}
