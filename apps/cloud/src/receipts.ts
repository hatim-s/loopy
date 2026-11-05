import type { DurableObjectState } from "@cloudflare/workers-types";
import { Cause, Effect, Result } from "effect";
import {
  type AuthorityCommand,
  AuthorityError,
  type AuthorityInput,
  type AuthorityOutput,
  authorityCommandSchema,
  authorityOperations,
  decodeBoundary,
  encodeBoundary,
  type ResultRef,
  resultOperations,
  SANDBOX_MAX_REQUEST_BYTES,
  type SandboxExecutionResult,
} from "../../../packages/loopy/src/contract/index.js";
import type { Environment } from "./environment.js";
import { readBoundedText } from "./http.js";
import { CloudError, cloudSync } from "./operation.js";
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

  fetch(request: Request): Promise<Response> {
    return Effect.runPromise(
      this.handle(request).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) {
            return Effect.failCause(cause);
          }

          const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined;

          return Effect.succeed(
            reason && Cause.isFailReason(reason) && reason.error instanceof AuthorityError
              ? Response.json({ error: reason.error.code }, { status: 409 })
              : Response.json({ error: "storage_unavailable" }, { status: 500 }),
          );
        }),
      ),
    );
  }
  private handle(request: Request) {
    return Effect.gen({ self: this }, function* () {
      const rejected = receiptAccess(request, this.env);

      if (rejected) {
        return rejected;
      }

      const text = yield* readBoundedText(new Response(request.body), SANDBOX_MAX_REQUEST_BYTES);

      const parsed = yield* Effect.result(
        cloudSync("decode command", () => decodeBoundary(authorityCommandSchema)(JSON.parse(text))),
      );

      if (Result.isFailure(parsed)) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }

      const command = parsed.success;

      // Effect's empty Struct accepts arbitrary object fields. Status has no inputs.
      if (command.operation === "status" && Object.keys(command.input).length !== 0) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }

      const output = yield* this.command(command);

      const schema =
        command.operation === "resultPut"
          ? resultOperations.resultPut.output
          : command.operation === "resultGet"
            ? resultOperations.resultGet.output
            : authorityOperations[command.operation].output;

      return Response.json(
        yield* cloudSync("encode receipt response", () => encodeBoundary(schema)(output)),
      );
    });
  }

  private resultsFor(workspace: string) {
    return new R2ImmutableResults(this.env.RECEIPT_RESULTS, this.config.namespace, workspace);
  }

  private complete(
    input: AuthorityInput<"complete">,
  ): Effect.Effect<AuthorityOutput<"complete">, CloudError> {
    return Effect.gen({ self: this }, function* () {
      const session = yield* Effect.result(receiptSync(() => this.db.checkSession(input.session)));

      if (Result.isFailure(session)) {
        if (session.failure instanceof AuthorityError) {
          return { kind: "rejected", code: session.failure.code };
        }

        return yield* Effect.fail(session.failure);
      }

      const record = yield* cloudSync("read receipt", () => this.db.read(input.id));

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
      yield* this.resultsFor(record.plan.workspace).get(input.result);

      return yield* cloudSync("complete receipt", () => this.authority.complete(input));
    });
  }

  private command(
    command: AuthorityCommand,
  ): Effect.Effect<
    AuthorityOutput<keyof typeof authorityOperations> | ResultRef | SandboxExecutionResult,
    CloudError | AuthorityError
  > {
    return Effect.gen({ self: this }, function* () {
      switch (command.operation) {
        case "status":
          return { epoch: yield* receiptSync(() => this.db.current()?.epoch ?? 0) };
        case "openSession":
          return yield* receiptSync(() => this.db.openSession(command.input));
        case "read":
          return yield* receiptSync(() => this.db.read(command.input.id));
        case "admit":
          if (!(yield* validReceiptPlan(this.config.root, command.input.plan))) {
            return { kind: "rejected", code: "invalid_state" };
          }

          return yield* receiptSync(() => this.authority.admit(command.input));
        case "complete":
          return yield* this.complete(command.input);
        case "beginExport":
          return yield* receiptSync(() => this.authority.beginExport(command.input));
        case "endExport":
          yield* receiptSync(() => this.authority.endExport(command.input));

          return null;
        case "exportGuards":
          return yield* receiptSync(() => this.db.exportGuards(command.input));
        case "recoverable":
          return yield* receiptSync(() => this.db.recoverable(command.input));
        case "resultPut":
          return yield* this.resultsFor(command.input.workspace).put(command.input.value);
        case "resultGet":
          return yield* this.resultsFor(command.input.workspace).get(command.input.ref);
      }
    });
  }
}

function receiptSync<A>(work: () => A) {
  return Effect.try({
    try: work,
    catch: (cause) =>
      cause instanceof AuthorityError
        ? cause
        : new CloudError({ operation: "receipt transaction", cause }),
  });
}
