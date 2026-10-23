import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthorityError,
  type AuthoritySession,
  artifactHelperName,
} from "../../../packages/loopy/src/contract/sandbox-journal.js";
import type {
  AuthorityInput,
  AuthorityOutput,
  SandboxAttemptAuthority,
} from "../../../packages/loopy/src/contract/sandbox-journal-rpc.js";
import { FilesystemJournal } from "./filesystem-journal.js";
import { FilesystemResults, resultReference } from "./immutable-results.js";
import { missing, syncDirectory, writeAtomic } from "./journal-files.js";

export class FilesystemAuthority implements SandboxAttemptAuthority {
  private session: AuthoritySession | null = null;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly journal: FilesystemJournal;
  constructor(private readonly root: string) {
    this.journal = new FilesystemJournal(root);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (this.closed) {
        throw new AuthorityError("stale_session");
      }

      return operation();
    });

    this.queue = next.catch(() => undefined);

    return next;
  }

  private current(session: AuthoritySession) {
    return this.session?.epoch === session.epoch && this.session.nonce === session.nonce;
  }

  // The OS lock supplies exclusion. This adapter makes no persistent epoch claim.
  async status() {
    return { epoch: this.session ? 1 : 0 };
  }

  openSession(input: AuthorityInput<"openSession">) {
    return this.serial(async () => {
      if (this.session?.nonce === input.nonce) {
        return this.session;
      }

      if (input.expectedEpoch !== (this.session ? 1 : 0)) {
        throw new AuthorityError("stale_session");
      }

      this.session = { epoch: 1, nonce: input.nonce };

      return this.session;
    });
  }

  read(id: string) {
    return this.journal.read(id);
  }

  admit(input: AuthorityInput<"admit">): Promise<AuthorityOutput<"admit">> {
    return this.serial(async () => {
      if (!this.current(input.session)) {
        return { kind: "rejected", code: "stale_session" };
      }

      if (!this.journal.validPlan(input.plan)) {
        return { kind: "rejected", code: "invalid_state" };
      }

      const existing = await this.read(input.plan.id);

      if (existing) {
        return existing.plan.requestHash === input.plan.requestHash
          ? { kind: "existing", record: existing }
          : { kind: "rejected", code: "request_conflict" };
      }

      if ((await this.journal.guards()).some((guard) => guard.volume === input.plan.volume)) {
        return { kind: "rejected", code: "workspace_busy" };
      }

      const record = { kind: "started", plan: input.plan, session: input.session } as const;
      await writeAtomic(join(this.root, "receipts", `${input.plan.id}.json`), record);

      return { kind: "created", record };
    });
  }

  complete(input: AuthorityInput<"complete">): Promise<AuthorityOutput<"complete">> {
    return this.serial(async () => {
      if (!this.current(input.session)) {
        return { kind: "rejected", code: "stale_session" };
      }

      const existing = await this.read(input.id);

      if (!existing) {
        return { kind: "rejected", code: "missing" };
      }

      if (existing.plan.requestHash !== input.requestHash) {
        return { kind: "rejected", code: "request_conflict" };
      }

      if (existing.kind === "finished") {
        const ref =
          existing.result.kind === "blob"
            ? existing.result.ref
            : resultReference(existing.result.value);

        return ref.sha256 === input.result.sha256 && ref.size === input.result.size
          ? { kind: "finished", record: existing }
          : { kind: "rejected", code: "request_conflict" };
      }

      await new FilesystemResults(this.root, existing.plan.workspace).get(input.result);

      const record = {
        ...existing,
        kind: "finished",
        result: { kind: "blob", ref: input.result },
      } as const;

      await writeAtomic(join(this.root, "receipts", `${input.id}.json`), record);

      return { kind: "finished", record };
    });
  }

  beginExport(input: AuthorityInput<"beginExport">): Promise<AuthorityOutput<"beginExport">> {
    return this.serial(async () => {
      if (!this.current(input.session)) {
        return { kind: "rejected", code: "stale_session" };
      }

      const guards = await this.journal.guards();
      const released = await this.journal.released(input.token);

      if (released) {
        return {
          kind: "rejected",
          code: released.attemptId === input.attemptId ? "invalid_state" : "request_conflict",
        };
      }

      const same = guards.find((guard) => guard.token === input.token);

      if (same) {
        return same.attemptId === input.attemptId
          ? { kind: "granted", record: same }
          : { kind: "rejected", code: "request_conflict" };
      }

      const receipt = await this.read(input.attemptId);

      if (!receipt) {
        return { kind: "rejected", code: "missing" };
      }

      if (receipt.kind !== "finished") {
        return { kind: "rejected", code: "invalid_state" };
      }

      if (
        guards.some((guard) => guard.volume === receipt.plan.volume) ||
        (await this.journal.records()).some(
          (record) => record.kind === "started" && record.plan.volume === receipt.plan.volume,
        )
      ) {
        return { kind: "rejected", code: "workspace_busy" };
      }

      const record = {
        token: input.token,
        session: input.session,
        attemptId: input.attemptId,
        volume: receipt.plan.volume,
        helper: artifactHelperName(input.attemptId),
      };

      await writeAtomic(join(this.root, "exports", `${input.attemptId}.json`), record);

      return { kind: "granted", record };
    });
  }

  endExport(input: AuthorityInput<"endExport">) {
    return this.serial(async () => {
      if (!this.current(input.session)) {
        throw new AuthorityError("stale_session");
      }

      const guard = (await this.journal.guards()).find((record) => record.token === input.token);

      if (guard) {
        await writeAtomic(this.journal.releasedPath(guard.token), guard);
        await unlink(join(this.root, "exports", `${guard.attemptId}.json`)).catch(
          (cause: unknown) => {
            if (!missing(cause)) {
              throw cause;
            }
          },
        );
        await syncDirectory(join(this.root, "exports"));
      }
    });
  }

  async exportGuards(
    input: AuthorityInput<"exportGuards">,
  ): Promise<AuthorityOutput<"exportGuards">> {
    const guards = (await this.journal.exportMetadata())
      .filter(
        (guard) =>
          guard.volume === input.volume &&
          (input.after === null ||
            Buffer.compare(Buffer.from(guard.token), Buffer.from(input.after)) > 0),
      )
      .sort((a, b) => Buffer.compare(Buffer.from(a.token), Buffer.from(b.token)));

    const page = guards.slice(0, input.limit);

    return {
      exports: page,
      next: guards.length > input.limit ? (page.at(-1)?.token ?? null) : null,
    };
  }

  async recoverable(input: AuthorityInput<"recoverable">): Promise<AuthorityOutput<"recoverable">> {
    const entries = [
      ...(await this.journal.records())
        .filter((record) => record.kind === "started")
        .map((record) => ({ key: `a:${record.plan.id}`, record })),
      ...(await this.journal.guards()).map((guard) => ({ key: `e:${guard.attemptId}`, guard })),
    ]
      .filter((entry) => input.after === null || entry.key > input.after)
      .sort((a, b) => a.key.localeCompare(b.key));

    const page = entries.slice(0, input.limit);

    return {
      attempts: page.flatMap((entry) => ("record" in entry ? [entry.record] : [])),
      exports: page.flatMap((entry) => ("guard" in entry ? [entry.guard] : [])),
      next: entries.length > input.limit ? (page.at(-1)?.key ?? null) : null,
    };
  }

  async close() {
    this.closed = true;
    await this.queue;
  }
}
