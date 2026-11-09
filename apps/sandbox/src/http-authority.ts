import { decodeBoundary } from "@loopy/contract";
import {
  AUTHORITY_MAX_BODY_BYTES,
  AUTHORITY_REJECTED_STATUS,
  AuthorityError,
  type AuthorityInput,
  authorityErrorSchema,
  type authorityOperations,
  isLoopbackOrigin,
  type OperationInput,
  type OperationName,
  operationOutput,
  RECEIPTS_NAMESPACE_HEADER,
  RECEIPTS_PATH,
} from "@loopy/contract/sandbox";
import { readBoundedBody } from "@loopy/runtime/http";
import { Effect } from "effect";
import type { ImmutableResults, SandboxAttemptAuthority } from "./authority";
import { failure } from "./operations";

export class HttpSandboxAuthority implements SandboxAttemptAuthority {
  private readonly endpoint: URL;

  constructor(private readonly options: { url: string; token: string; namespace: string }) {
    const base = new URL(options.url);

    if (!isLoopbackOrigin(base)) {
      throw new Error(
        "Receipt authority requires a loopback HTTP origin without credentials or a path.",
      );
    }

    this.endpoint = new URL(RECEIPTS_PATH, base);
  }

  private call<K extends OperationName>(operation: K, input: OperationInput<K>) {
    return Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(this.endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            [RECEIPTS_NAMESPACE_HEADER]: this.options.namespace,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ operation, input }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });

        if (!response.ok) {
          if (response.status === AUTHORITY_REJECTED_STATUS) {
            const body: unknown = JSON.parse(await this.body(response));
            const rejected = decodeBoundary(authorityErrorSchema)(body);
            throw new AuthorityError(rejected.error);
          }

          await response.body?.cancel();

          throw new Error(
            `Receipt authority returned HTTP ${response.status}. Restore local storage before resuming.`,
          );
        }

        const body: unknown = JSON.parse(await this.body(response));

        return decodeBoundary(operationOutput(operation))(body);
      },
      catch: (cause) =>
        cause instanceof AuthorityError ? cause : failure("authority HTTP", cause),
    });
  }

  private async body(response: Response) {
    if (!response.body) {
      throw new Error("Receipt authority returned an empty response.");
    }

    const bytes = await Effect.runPromise(
      readBoundedBody(response.body, AUTHORITY_MAX_BODY_BYTES).pipe(
        Effect.catchTag("BodyLimitError", () =>
          Effect.die(new Error("Receipt authority response exceeds its byte limit.")),
        ),
      ),
    );

    return new TextDecoder().decode(bytes);
  }

  // TypeScript cannot build this per-operation record from the table without a cast, so each
  // operation is bound by name and the interface checks that none is missing.
  private readonly bind =
    <K extends keyof typeof authorityOperations>(operation: K) =>
    (input: AuthorityInput<K>) =>
      this.call(operation, input);

  readonly status = this.bind("status");
  readonly openSession = this.bind("openSession");
  readonly read = this.bind("read");
  readonly admit = this.bind("admit");
  readonly complete = this.bind("complete");
  readonly beginExport = this.bind("beginExport");
  readonly endExport = this.bind("endExport");
  readonly exportGuards = this.bind("exportGuards");
  readonly recoverable = this.bind("recoverable");

  resultsFor(workspace: string): ImmutableResults {
    return {
      put: (value) => this.call("resultPut", { workspace, value }),
      get: (ref) => this.call("resultGet", { workspace, ref }),
    };
  }
}
