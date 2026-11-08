import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routes } from "@loopy/contract";
import type { Json } from "@loopy/core";
import { Effect } from "effect";
import { writeDaemonFile } from "../../runtime/src/local/daemon/file";
import { HttpError, request, TransportError } from "../src/client";

async function withHttp(
  body: Json,
  status: number,
  use: (context: { home: string; cwd: string }, requests: () => string[]) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "loopy-cli-http-"));
  const authorizations: (string | null)[] = [];
  const requests: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      authorizations.push(req.headers.get("authorization"));
      requests.push(`${req.method} ${new URL(req.url).pathname}`);

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
    await use({ home: root, cwd: root }, () => requests);
    expect(authorizations.every((value) => value === "Bearer fixture-token")).toBe(true);
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

test("HTTP client fills the contract route, decodes the response and keeps error identity without retry", async () => {
  await withHttp(["TOKEN"], 200, async (context) => {
    expect(await Effect.runPromise(request(context, routes.secrets, {}))).toEqual(["TOKEN"]);
  });
  await withHttp(
    { error: { code: "not_found", message: "No run 'missing'." } },
    404,
    async (context, requests) => {
      const result = await Effect.runPromise(
        Effect.flip(request(context, routes.cancelRun, { params: { id: "missing/run" } })),
      );

      expect(result).toBeInstanceOf(HttpError);
      expect(result).toMatchObject({
        status: 404,
        code: "not_found",
        message: "No run 'missing'.",
      });
      expect(requests()).toEqual(["POST /api/runs/missing%2Frun/cancel"]);
    },
  );
});

test("HTTP client rejects malformed success and error envelopes", async () => {
  for (const [body, status] of [
    [{ unexpected: true }, 200],
    [{ error: { message: "missing code" } }, 400],
  ] as const) {
    await withHttp(body, status, async (context, requests) => {
      expect(
        await Effect.runPromise(Effect.flip(request(context, routes.secrets, {}))),
      ).toBeInstanceOf(TransportError);
      expect(requests()).toHaveLength(1);
    });
  }
});

test("CLI argument failures report their message", async () => {
  const { main } = await import("../src");

  for (const [argv, message] of [
    [["unknown-command"], "Unknown command 'unknown-command'."],
    [["types", "bun"], "--out is required."],
    [["secrets", "remove"], "Secret name is required. Run loopy secrets remove --help for usage."],
  ] as const) {
    expect((await Effect.runPromise(Effect.flip(main([...argv])))).message).toStartWith(message);
  }
});
