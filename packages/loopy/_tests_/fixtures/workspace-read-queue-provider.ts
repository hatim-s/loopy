import {
  type Json,
  sandboxAttemptIdentitySchema,
  sandboxAttemptRequestSchema,
  sandboxReceiptSchema,
} from "../../src/contract/index.js";

export type QueueProofDetails = Record<string, Json | undefined>;

export type QueueProofEvent = { event: string; atMs: number; details?: QueueProofDetails };

export function readQueueProvider(
  mode: "lookup" | "start",
  record: (event: string, details?: QueueProofDetails) => void,
) {
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
    record("provider-release", { mode, reason });
    gate.resolve();
  }

  async function hold() {
    record("provider-held", { mode });

    // Release before SandboxProvider's five-second timeout, even if an assertion fails.
    if (releaseReason === null) {
      watchdog = setTimeout(() => release("watchdog"), 3500);
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
            ? sandboxAttemptRequestSchema.parse(body)
            : sandboxAttemptIdentitySchema.parse({
                workspace: url.searchParams.get("workspace"),
                executionKey: JSON.parse(url.searchParams.get("key") ?? "null"),
                attempt: Number(url.searchParams.get("attempt")),
              });

        if (identity.workspace !== mode) {
          throw new Error("Provider request crossed the synthetic workspace boundary.");
        }

        record("provider-request", { method: request.method, identity });

        if (request.method === "GET") {
          lookups++;

          if (mode === "lookup" && lookups === 1) {
            await hold();
          }

          return Response.json(sandboxReceiptSchema.parse({ kind: "none" }));
        }

        const id = JSON.stringify([identity.workspace, identity.executionKey, identity.attempt]);
        admissions.push(id);
        record("synthetic-admission", { id });

        if (mode === "start") {
          await hold();
        }

        return Response.json(
          sandboxReceiptSchema.parse({
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
        record("provider-error", { message });

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
