import type { CompileRequest, CompileResult, IsolatedCompiler } from "./service.js";

export type HttpCompilerOptions = {
  readonly origin: string;
  readonly serviceToken: string;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

/** The compiler service token authenticates the host connection and never enters the bundle. */
export class HttpIsolatedCompiler implements IsolatedCompiler {
  private readonly endpoint: URL;
  constructor(private readonly options: HttpCompilerOptions) {
    const url = new URL(options.origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Compiler service requires an explicit HTTPS origin");
    if (!options.serviceToken || /[\r\n]/.test(options.serviceToken))
      throw new Error("Compiler service token is required");
    this.endpoint = new URL("/compile", url);
  }
  async compile(request: CompileRequest): Promise<CompileResult> {
    request.signal.throwIfAborted();
    const remaining = request.policy.deadlineMs - Date.now();
    if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > 60_000)
      throw new Error("Compiler deadline exceeded");
    const body = JSON.stringify({ bundle: request.bundle, policy: request.policy });
    if (new TextEncoder().encode(body).byteLength > 1_000_000)
      throw new Error("Compiler request exceeds limits");
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(remaining)]);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.serviceToken}`,
        },
        body,
      });
    } catch {
      throw new Error("Compiler service request failed");
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Compiler service failed with HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) break;
        count += item.value.byteLength;
        if (count > 128_000) throw new Error("Compiler service response exceeds limits");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !value ||
      typeof value !== "object" ||
      !("workflow" in value) ||
      !("imageDigest" in value) ||
      typeof value.imageDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(value.imageDigest)
    )
      throw new Error("Compiler service returned an invalid result");
    return { workflow: value.workflow, imageDigest: value.imageDigest };
  }
}
