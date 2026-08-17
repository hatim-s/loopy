import { describe, expect, it, vi } from "vitest";
import { bootstrapSession, createApiClient, createAuthenticatedApiClient } from "../src/app/api";

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
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
});
