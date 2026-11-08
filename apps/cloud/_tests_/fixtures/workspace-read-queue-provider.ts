import { decodeBoundary, receiptSchema } from "@loopy/contract";
import { sandboxAttemptQuerySchema, sandboxAttemptRequestSchema } from "@loopy/contract/sandbox";
import { SANDBOX_REQUEST_TIMEOUT_MS } from "../../src/provider";

export function readQueueProvider(mode: "lookup" | "start") {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const admissions: string[] = [];
  const errors: string[] = [];
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let releaseReason: string | null = null;
  let lookups = 0;

  function release(reason: "manual" | "watchdog" | "cleanup") {
    if (releaseReason !== null) {
      return;
    }

    releaseReason = reason;
    clearTimeout(watchdog);
    gate.resolve();
  }

  async function hold() {
    // Release before the provider request times out, even if an assertion fails.
    if (releaseReason === null) {
      watchdog = setTimeout(() => release("watchdog"), SANDBOX_REQUEST_TIMEOUT_MS - 1500);
    }

    entered.resolve();
    await gate.promise;
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        const url = new URL(request.url);

        if (
          url.pathname !== "/attempts" ||
          !["GET", "POST"].includes(request.method) ||
          request.headers.get("Authorization") !== "Bearer read-queue-synthetic-provider"
        ) {
          throw new Error("Unexpected synthetic provider request.");
        }

        const body: unknown = request.method === "POST" ? await request.json() : undefined;

        const identity =
          request.method === "POST"
            ? decodeBoundary(sandboxAttemptRequestSchema)(body)
            : decodeBoundary(sandboxAttemptQuerySchema)(Object.fromEntries(url.searchParams));

        if (identity.workspace !== mode) {
          throw new Error("Provider request crossed the synthetic workspace boundary.");
        }

        if (request.method === "GET") {
          lookups++;

          if (mode === "lookup" && lookups === 1) {
            await hold();
          }

          return Response.json(decodeBoundary(receiptSchema)({ kind: "none" }));
        }

        const id = JSON.stringify([identity.workspace, identity.executionKey, identity.attempt]);
        admissions.push(id);

        if (mode === "start") {
          await hold();
        }

        return Response.json(
          decodeBoundary(receiptSchema)({
            kind: "finished",
            result: {
              kind: "succeeded",
              output: { stdout: "synthetic result", stderr: "", exitCode: 0 },
              logs: [],
            },
          }),
        );
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        errors.push(message);

        return new Response("Synthetic provider rejected the request.", { status: 500 });
      }
    },
  });

  return {
    url: server.url.origin,
    entered: entered.promise,
    release,
    admissions,
    errors,
    get releaseReason() {
      return releaseReason;
    },
    get lookups() {
      return lookups;
    },
    async close() {
      release("cleanup");
      await server.stop(true);
    },
  };
}
