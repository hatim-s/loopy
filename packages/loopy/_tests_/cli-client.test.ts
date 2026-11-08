import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routes } from "@loopy/contract";
import type { Json } from "@loopy/core";
import { Effect } from "effect";
import { HttpError, request, TransportError } from "../../cli/src/client";
import { writeDaemonFile } from "../../runtime/src/local/daemon/file";

async function withHttp(
  body: Json,
  status: number,
  use: (context: { home: string; cwd: string }, count: () => number) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "loopy-cli-http-"));
  const authorizations: (string | null)[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      authorizations.push(req.headers.get("authorization"));

      return Response.json(body, { status });
    },
  });

  try {
    writeDaemonFile(root, {
      pid: process.pid,
      port: server.port!,
      token: "fixture-token",
      startedAt: new Date().toISOString(),
    });
    await use({ home: root, cwd: root }, () => authorizations.length);
    expect(authorizations.every((value) => value === "Bearer fixture-token")).toBe(true);
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

test("HTTP client decodes a real fixture response and preserves public error identity without retry", async () => {
  await withHttp(["TOKEN"], 200, async (context) => {
    expect(await Effect.runPromise(request(context, "/secrets", routes.secrets.response))).toEqual([
      "TOKEN",
    ]);
  });
  await withHttp(
    { error: { code: "not_found", message: "No run 'missing'." } },
    404,
    async (context, count) => {
      const result = await Effect.runPromise(
        Effect.flip(
          request(context, "/runs/missing/cancel", routes.cancelRun.response, { method: "POST" }),
        ),
      );

      expect(result).toBeInstanceOf(HttpError);
      expect(result).toMatchObject({
        status: 404,
        code: "not_found",
        message: "No run 'missing'.",
      });
      expect(count()).toBe(1);
    },
  );
});

test("HTTP client rejects malformed success and error envelopes", async () => {
  for (const [body, status] of [
    [{ unexpected: true }, 200],
    [{ error: { message: "missing code" } }, 400],
  ] as const) {
    await withHttp(body, status, async (context, count) => {
      expect(
        await Effect.runPromise(Effect.flip(request(context, "/secrets", routes.secrets.response))),
      ).toBeInstanceOf(TransportError);
      expect(count()).toBe(1);
    });
  }
});

test("CLI argument failures report their message", async () => {
  const { main } = await import("@loopy/cli");

  for (const [argv, message] of [
    [["unknown-command"], "Unknown command 'unknown-command'."],
    [["types", "bun"], "--out is required."],
    [["secrets", "remove"], "Secret name is required. Run loopy secrets remove --help for usage."],
  ] as const) {
    expect((await Effect.runPromise(Effect.flip(main([...argv])))).message).toStartWith(message);
  }
});
