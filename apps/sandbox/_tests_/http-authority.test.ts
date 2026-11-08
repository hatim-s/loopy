import { expect, test } from "bun:test";
import { AuthorityError, RECEIPTS_NAMESPACE_HEADER } from "@loopy/contract/sandbox";
import { Effect, Result } from "effect";
import { HttpSandboxAuthority } from "../src/http-authority";

test("loopback authority HTTP keeps exact command and rejection envelopes", async () => {
  const seen: unknown[] = [];
  const namespaces: (string | null)[] = [];
  let reject = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      namespaces.push(request.headers.get(RECEIPTS_NAMESPACE_HEADER));
      seen.push(await request.json());

      return reject
        ? Response.json({ error: "stale_session" }, { status: 409 })
        : Response.json({ epoch: 0 });
    },
  });

  try {
    const authority = new HttpSandboxAuthority({
      url: server.url.origin,
      token: "fixture",
      namespace: "fixture",
    });

    expect(await Effect.runPromise(authority.status({}))).toEqual({ epoch: 0 });
    reject = true;
    const result = await Effect.runPromise(authority.status({}).pipe(Effect.result));
    expect(
      Result.isFailure(result) && result.failure instanceof AuthorityError && result.failure.code,
    ).toBe("stale_session");
    expect(seen).toEqual([
      { operation: "status", input: {} },
      { operation: "status", input: {} },
    ]);
    expect(namespaces).toEqual(["fixture", "fixture"]);
  } finally {
    await server.stop(true);
  }
});

test("HTTP adapter refuses cloud origins and rejects malformed operation responses", async () => {
  for (const url of [
    "https://127.0.0.1",
    "http://cloud.invalid",
    "http://127.0.0.1/path",
    "http://user@localhost",
    "http://localhost/#fragment",
  ]) {
    expect(() => new HttpSandboxAuthority({ url, token: "fixture", namespace: "fixture" })).toThrow(
      "requires a loopback HTTP origin",
    );
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ kind: "none" }),
  });

  try {
    const client = new HttpSandboxAuthority({
      url: server.url.origin,
      token: "fixture",
      namespace: "fixture",
    });

    await expect(Effect.runPromise(client.read({ id: "f".repeat(64) }))).rejects.toThrow(
      "Expected",
    );
  } finally {
    await server.stop(true);
  }
});
