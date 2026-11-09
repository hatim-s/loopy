import type { DurableObjectState } from "@cloudflare/workers-types";
import { decodeBoundary, encodeBoundary } from "@loopy/contract";
import {
  type AuthorityCommand,
  AuthorityError,
  authorityCommandSchema,
  type OperationInput,
  type OperationName,
  type OperationOutput,
  operationOutput,
  planMatches,
  SANDBOX_MAX_REQUEST_BYTES,
} from "@loopy/contract/sandbox";
import { Cause, Effect, Result } from "effect";
import type { Environment } from "../environment";
import { readBoundedText } from "../http";
import { CloudError, cloudSync, platform } from "../operation";
import { ReceiptAuthority } from "./authority";
import { R2ImmutableResults } from "./results";
import { receiptAccess, receiptsConfiguration } from "./route";
import { ReceiptSql } from "./sql";

type ReceiptHandlers = {
  [K in OperationName]: (
    input: OperationInput<K>,
  ) => Effect.Effect<OperationOutput<K>, CloudError | AuthorityError>;
};

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

      return Response.json(yield* this.command(parsed.success));
    });
  }

  private command<K extends OperationName>(command: AuthorityCommand<K>) {
    return Effect.gen({ self: this }, function* () {
      const output = yield* this.handlers[command.operation](command.input);

      return yield* cloudSync("encode receipt response", () =>
        encodeBoundary(operationOutput(command.operation))(output),
      );
    });
  }

  private resultsFor(workspace: string) {
    return new R2ImmutableResults(this.env.RECEIPT_RESULTS, this.config.namespace, workspace);
  }

  private readonly handlers: ReceiptHandlers = {
    status: () => receiptSync(() => ({ epoch: this.db.current()?.epoch ?? 0 })),
    openSession: (input) => receiptSync(() => this.db.openSession(input)),
    read: (input) => receiptSync(() => this.db.read(input.id)),
    admit: (input) =>
      Effect.gen({ self: this }, function* () {
        const valid = yield* platform("verify plan", () =>
          planMatches(this.config.root, input.plan),
        );

        return yield* receiptSync(() => this.authority.admit(input, valid));
      }),
    complete: (input) =>
      Effect.gen({ self: this }, function* () {
        const decision = yield* receiptSync(() => this.authority.completion(input));

        if (decision.kind !== "publish") {
          return decision;
        }

        // Verify durable bytes before publishing their pointer. The transaction decides again.
        yield* this.resultsFor(decision.record.plan.workspace).get(input.result);

        return yield* receiptSync(() => this.authority.complete(input));
      }),
    beginExport: (input) => receiptSync(() => this.authority.beginExport(input)),
    endExport: (input) => receiptSync(() => this.authority.endExport(input)),
    exportGuards: (input) => receiptSync(() => this.db.exportGuards(input)),
    recoverable: (input) => receiptSync(() => this.db.recoverable(input)),
    resultPut: (input) => this.resultsFor(input.workspace).put(input.value),
    resultGet: (input) => this.resultsFor(input.workspace).get(input.ref),
  };
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
