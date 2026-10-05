import { timingSafeEqual } from "node:crypto";
import { type PublishBundle, verifyPublishBundle } from "../publishing/manifest.js";
import type { CompileRequest, IsolatedCompiler } from "../publishing/service.js";

export type CompilerServiceOptions = {
  readonly serviceToken: string;
  readonly compiler: IsolatedCompiler;
};

/** Trusted Node/Bun handler. Hosting and the independent service credential are host configuration. */
export function createCompilerHandler(
  options: CompilerServiceOptions,
): (request: Request) => Promise<Response> {
  if (!options.serviceToken || /[\r\n]/.test(options.serviceToken))
    throw new Error("Compiler service token is required");
  const expected = new TextEncoder().encode(`Bearer ${options.serviceToken}`);
  return async (request) => {
    const supplied = new TextEncoder().encode(request.headers.get("authorization") ?? "");
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected))
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (new URL(request.url).pathname !== "/compile" || request.method !== "POST")
      return Response.json({ error: "Not found" }, { status: 404 });
    try {
      if (!request.body) throw new Error("Missing compiler request");
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let count = 0;
      try {
        while (true) {
          request.signal.throwIfAborted();
          const item = await reader.read();
          if (item.done) break;
          count += item.value.byteLength;
          if (count > 1_000_000) throw new Error("Compiler request exceeds limits");
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
        !("bundle" in value) ||
        !("policy" in value) ||
        Object.keys(value).some((key) => key !== "bundle" && key !== "policy")
      )
        throw new Error("Invalid compiler request");
      const policy = value.policy as CompileRequest["policy"];
      if (
        !policy ||
        !Number.isSafeInteger(policy.deadlineMs) ||
        policy.deadlineMs <= Date.now() ||
        policy.deadlineMs > Date.now() + 60_000 ||
        policy.maxOutputBytes !== 100_000 ||
        policy.serviceCredentials !== false ||
        policy.dependencies !== "locked-only" ||
        Object.keys(policy).some(
          (key) =>
            !["deadlineMs", "maxOutputBytes", "serviceCredentials", "dependencies"].includes(key),
        )
      )
        throw new Error("Unsupported compiler policy");
      const bundle = await verifyPublishBundle(value.bundle as PublishBundle);
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(Math.max(1, policy.deadlineMs - Date.now())),
      ]);
      signal.throwIfAborted();
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Compiler deadline or cancellation reached"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const result = await Promise.race([
        options.compiler.compile({ bundle, policy, signal }),
        aborted,
      ]).finally(() => {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      });
      signal.throwIfAborted();
      const resultText = JSON.stringify(result);
      if (new TextEncoder().encode(resultText).byteLength > 128_000)
        throw new Error("Compiler result exceeds limits");
      return new Response(resultText, { headers: { "Content-Type": "application/json" } });
    } catch {
      return Response.json({ error: "Isolated compilation failed" }, { status: 422 });
    }
  };
}
