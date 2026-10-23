import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  type AuthorityCommand,
  AuthorityError,
  type AuthorityInput,
  type AuthorityOutput,
  authorityCommandSchema,
  type authorityOperations,
  type ResultRef,
  SANDBOX_MAX_REQUEST_BYTES,
  type SandboxExecutionResult,
} from "../../../packages/loopy/src/contract/index.js";
import type { Environment } from "./environment.js";
import { readBoundedText } from "./http.js";
import { ReceiptAuthority } from "./receipts-authority.js";
import { validReceiptPlan } from "./receipts-identity.js";
import { R2ImmutableResults } from "./receipts-results.js";
import { receiptAccess, receiptsConfiguration } from "./receipts-route.js";
import { ReceiptSql } from "./receipts-sql.js";

export class SandboxReceipts {
  private readonly db: ReceiptSql;
  private readonly authority: ReceiptAuthority;
  private readonly config;

  constructor(
    ctx: DurableObjectState,
    private readonly env: Environment,
  ) {
    this.config = receiptsConfiguration(env);
    this.db = new ReceiptSql(ctx.storage, this.config.namespace, this.config.root);
    this.authority = new ReceiptAuthority(this.db);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const rejected = receiptAccess(request, this.env);

      if (rejected) {
        return rejected;
      }

      const text = await readBoundedText(new Response(request.body), SANDBOX_MAX_REQUEST_BYTES);
      let command: AuthorityCommand;

      try {
        command = authorityCommandSchema.parse(JSON.parse(text));
      } catch {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }

      return Response.json(await this.command(command));
    } catch (error) {
      if (error instanceof AuthorityError) {
        return Response.json({ error: error.code }, { status: 409 });
      }

      return Response.json({ error: "storage_unavailable" }, { status: 500 });
    }
  }

  private resultsFor(workspace: string) {
    return new R2ImmutableResults(this.env.RECEIPT_RESULTS, this.config.namespace, workspace);
  }

  private async complete(input: AuthorityInput<"complete">): Promise<AuthorityOutput<"complete">> {
    try {
      this.db.checkSession(input.session);
    } catch (error) {
      if (error instanceof AuthorityError) {
        return { kind: "rejected", code: error.code };
      }

      throw error;
    }

    const record = this.db.read(input.id);

    if (!record) {
      return { kind: "rejected", code: "missing" };
    }

    if (record.plan.requestHash !== input.requestHash) {
      return { kind: "rejected", code: "request_conflict" };
    }

    if (
      record.kind === "finished" &&
      (record.result.kind !== "blob" ||
        record.result.ref.sha256 !== input.result.sha256 ||
        record.result.ref.size !== input.result.size)
    ) {
      return { kind: "rejected", code: "request_conflict" };
    }

    // Verify durable bytes before publishing their pointer. The transaction rechecks the session.
    await this.resultsFor(record.plan.workspace).get(input.result);

    return this.authority.complete(input);
  }

  private async command(
    command: AuthorityCommand,
  ): Promise<
    AuthorityOutput<keyof typeof authorityOperations> | ResultRef | SandboxExecutionResult
  > {
    switch (command.operation) {
      case "status":
        return { epoch: this.db.current()?.epoch ?? 0 };
      case "openSession":
        return this.db.openSession(command.input);
      case "read":
        return this.db.read(command.input.id);
      case "admit":
        if (!(await validReceiptPlan(this.config.root, command.input.plan))) {
          return { kind: "rejected", code: "invalid_state" };
        }

        return this.authority.admit(command.input);
      case "complete":
        return this.complete(command.input);
      case "beginExport":
        return this.authority.beginExport(command.input);
      case "endExport":
        this.authority.endExport(command.input);

        return null;
      case "recoverable":
        return this.db.recoverable(command.input);
      case "resultPut":
        return this.resultsFor(command.input.workspace).put(command.input.value);
      case "resultGet":
        return this.resultsFor(command.input.workspace).get(command.input.ref);
    }
  }
}
