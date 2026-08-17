import { describe, expect, it, vi } from "vitest";
import { bootstrapSession, createApiClient, createAuthenticatedApiClient } from "../src/app/api";

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

async function waitForAssertion(assertion: () => void, timeoutMs = 1_000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Assertion timed out");
}

describe("studio API client", () => {
  it("keeps auth in memory and sends credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true }));
    const client = createAuthenticatedApiClient({
      baseUrl: "http://studio.test/api",
      token: "secret",
      fetcher,
    });
    await client.request("runs", { method: "POST", body: "{}" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://studio.test/api/runs",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer secret",
    );
    expect(client.getToken()).toBe("secret");
  });

  it("accepts a cookie bootstrap without persisting its token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ token: "session-token" }));
    await expect(bootstrapSession({ baseUrl: "/api", fetcher })).resolves.toEqual({
      token: "session-token",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(Object.keys(globalThis)).not.toContain("localStorage");
  });

  it("normalizes API errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("offline", { status: 503, statusText: "Unavailable" }));
    await expect(createApiClient({ fetcher }).request("status")).rejects.toMatchObject({
      status: 503,
      message: "Unavailable",
    });
  });

  it("parses authenticated SSE events without putting the token in the URL", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          'event: heartbeat\ndata: {}\n\n\nid: 7\nevent: node.completed\ndata: {"type":"node.completed"}\n\n',
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    const received: Record<string, unknown>[] = [];
    const client = createAuthenticatedApiClient({
      baseUrl: "http://studio.test/api/v1",
      token: "secret",
      fetcher,
    });
    const stop = client.streamEvents("run 1", (event) => received.push(event));
    await waitForAssertion(() => expect(received).toHaveLength(1));
    stop();
    expect(received[0]).toMatchObject({ type: "node.completed", sequence: 7 });
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("secret");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer secret",
    );
  });
});
