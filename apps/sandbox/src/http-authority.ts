import type { Schema } from "effect";
import { Effect } from "effect";
import {
  type AuthorityCommand,
  AuthorityError,
  type AuthorityInput,
  authorityErrorSchema,
  authorityOperations,
  decodeBoundary,
  resultOperations,
  SANDBOX_MAX_REQUEST_BYTES,
} from "../../../packages/loopy/src/contract/index.js";
import { failure, type ImmutableResults, type SandboxAttemptAuthority } from "./operations.js";

export class HttpSandboxAuthority implements SandboxAttemptAuthority {
  private readonly endpoint: URL;

  constructor(private readonly options: { url: string; token: string; namespace: string }) {
    const base = new URL(options.url);

    if (
      base.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(base.hostname) ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash
    ) {
      throw new Error(
        "Receipt authority requires a loopback HTTP origin without credentials or a path.",
      );
    }

    this.endpoint = new URL("/internal/sandbox-receipts", base);
  }

  private request<S extends Schema.ConstraintDecoder<unknown>>(
    command: AuthorityCommand,
    schema: S,
  ) {
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
          body: JSON.stringify(command),
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

        return decodeBoundary(schema)(body);
      },
      catch: (cause) =>
        cause instanceof AuthorityError ? cause : failure("authority HTTP", cause),
    });
  }

  private async body(response: Response): Promise<string> {
    if (!response.body) {
      throw new Error("Receipt authority returned an empty response.");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
      while (true) {
        const next = await reader.read();

        if (next.done) {
          break;
        }

        size += next.value.byteLength;

        if (size > SANDBOX_MAX_REQUEST_BYTES) {
          await reader.cancel();
          throw new Error("Receipt authority response exceeds 16 MiB.");
        }

        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks).toString("utf8");
  }

  status() {
    return this.request({ operation: "status", input: {} }, authorityOperations.status.output);
  }

  openSession(input: AuthorityInput<"openSession">) {
    return this.request(
      { operation: "openSession", input },
      authorityOperations.openSession.output,
    );
  }

  read(id: string) {
    return this.request({ operation: "read", input: { id } }, authorityOperations.read.output);
  }

  admit(input: AuthorityInput<"admit">) {
    return this.request({ operation: "admit", input }, authorityOperations.admit.output);
  }

  complete(input: AuthorityInput<"complete">) {
    return this.request({ operation: "complete", input }, authorityOperations.complete.output);
  }

  beginExport(input: AuthorityInput<"beginExport">) {
    return this.request(
      { operation: "beginExport", input },
      authorityOperations.beginExport.output,
    );
  }

  endExport(input: AuthorityInput<"endExport">) {
    return this.request(
      { operation: "endExport", input },
      authorityOperations.endExport.output,
    ).pipe(Effect.asVoid);
  }

  exportGuards(input: AuthorityInput<"exportGuards">) {
    return this.request(
      { operation: "exportGuards", input },
      authorityOperations.exportGuards.output,
    );
  }

  recoverable(input: AuthorityInput<"recoverable">) {
    return this.request(
      { operation: "recoverable", input },
      authorityOperations.recoverable.output,
    );
  }

  resultsFor(workspace: string): ImmutableResults {
    return {
      put: (value) =>
        this.request(
          { operation: "resultPut", input: { workspace, value } },
          resultOperations.resultPut.output,
        ),
      get: (ref) =>
        this.request(
          { operation: "resultGet", input: { workspace, ref } },
          resultOperations.resultGet.output,
        ),
    };
  }
}
