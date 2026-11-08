import { decodeBoundary } from "@loopy/contract";
import {
  AuthorityError,
  type AuthorityInput,
  authorityErrorSchema,
  isLoopbackOrigin,
  type OperationInput,
  type OperationName,
  operationOutput,
  SANDBOX_MAX_REQUEST_BYTES,
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

    this.endpoint = new URL("/internal/sandbox-receipts", base);
  }

  private call<K extends OperationName>(operation: K, input: OperationInput<K>) {
    return Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(this.endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            "X-Loopy-Receipts-Namespace": this.options.namespace,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ operation, input }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });

        if (!response.ok) {
          if (response.status === 409) {
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
      readBoundedBody(response.body, SANDBOX_MAX_REQUEST_BYTES).pipe(
        Effect.catchTag("BodyLimitError", () =>
          Effect.die(new Error("Receipt authority response exceeds its byte limit.")),
        ),
      ),
    );

    return new TextDecoder().decode(bytes);
  }

  status(input: AuthorityInput<"status">) {
    return this.call("status", input);
  }

  openSession(input: AuthorityInput<"openSession">) {
    return this.call("openSession", input);
  }

  read(input: AuthorityInput<"read">) {
    return this.call("read", input);
  }

  admit(input: AuthorityInput<"admit">) {
    return this.call("admit", input);
  }

  complete(input: AuthorityInput<"complete">) {
    return this.call("complete", input);
  }

  beginExport(input: AuthorityInput<"beginExport">) {
    return this.call("beginExport", input);
  }

  endExport(input: AuthorityInput<"endExport">) {
    return this.call("endExport", input);
  }

  exportGuards(input: AuthorityInput<"exportGuards">) {
    return this.call("exportGuards", input);
  }

  recoverable(input: AuthorityInput<"recoverable">) {
    return this.call("recoverable", input);
  }

  resultsFor(workspace: string): ImmutableResults {
    return {
      put: (value) => this.call("resultPut", { workspace, value }),
      get: (ref) => this.call("resultGet", { workspace, ref }),
    };
  }
}
