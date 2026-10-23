import type { z } from "zod";
import {
  type AuthorityCommand,
  AuthorityError,
  type AuthorityInput,
  authorityErrorSchema,
  authorityOperations,
  type ImmutableResults,
  resultOperations,
  SANDBOX_MAX_REQUEST_BYTES,
  type SandboxAttemptAuthority,
} from "../../../packages/loopy/src/contract/index.js";

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

  private async request<T>(command: AuthorityCommand, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        "X-Loopy-Receipts-Namespace": this.options.namespace,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      if (response.status === 409) {
        const body: unknown = JSON.parse(await this.body(response));
        const rejected = authorityErrorSchema.safeParse(body);

        if (rejected.success) {
          throw new AuthorityError(rejected.data.error);
        }
      }

      await response.body?.cancel();

      throw new Error(
        `Receipt authority returned HTTP ${response.status}. Restore local storage before resuming.`,
      );
    }

    const body: unknown = JSON.parse(await this.body(response));

    return schema.parse(body);
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

  async status() {
    return this.request({ operation: "status", input: {} }, authorityOperations.status.output);
  }

  async openSession(input: AuthorityInput<"openSession">) {
    return this.request(
      { operation: "openSession", input },
      authorityOperations.openSession.output,
    );
  }

  async read(id: string) {
    return this.request({ operation: "read", input: { id } }, authorityOperations.read.output);
  }

  async admit(input: AuthorityInput<"admit">) {
    return this.request({ operation: "admit", input }, authorityOperations.admit.output);
  }

  async complete(input: AuthorityInput<"complete">) {
    return this.request({ operation: "complete", input }, authorityOperations.complete.output);
  }

  async beginExport(input: AuthorityInput<"beginExport">) {
    return this.request(
      { operation: "beginExport", input },
      authorityOperations.beginExport.output,
    );
  }

  async endExport(input: AuthorityInput<"endExport">): Promise<void> {
    await this.request({ operation: "endExport", input }, authorityOperations.endExport.output);
  }

  async exportGuards(input: AuthorityInput<"exportGuards">) {
    return this.request(
      { operation: "exportGuards", input },
      authorityOperations.exportGuards.output,
    );
  }

  async recoverable(input: AuthorityInput<"recoverable">) {
    return this.request(
      { operation: "recoverable", input },
      authorityOperations.recoverable.output,
    );
  }

  resultsFor(workspace: string): ImmutableResults {
    return {
      put: async (value) =>
        this.request(
          { operation: "resultPut", input: { workspace, value } },
          resultOperations.resultPut.output,
        ),
      get: async (ref) =>
        this.request(
          { operation: "resultGet", input: { workspace, ref } },
          resultOperations.resultGet.output,
        ),
    };
  }
}
