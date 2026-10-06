import { expect, test } from "bun:test";
import { createStudioClient } from "../src/local/studio-client.js";

test("Studio client encodes identifiers and keeps reads separate from execution", async () => {
  const requests: { path: string; init?: RequestInit }[] = [];
  const request = async (path: string, init?: RequestInit) => {
    requests.push({ path, init });
    return Response.json({});
  };
  const client = createStudioClient(request, () => "session-token");
  await client.workflow("one/two");
  await client.start("one", { message: "hello" }, "sandbox");
  await client.resume("run/one", false);
  expect(requests.map(({ path }) => path)).toEqual([
    "/api/workflows/one%2Ftwo",
    "/api/runs",
    "/api/runs/run%2Fone/resume",
  ]);
  expect(requests[0]?.init?.method).toBe("GET");
  expect(requests[0]?.init?.body).toBeUndefined();
  expect(requests[1]?.init?.method).toBe("POST");
  expect(JSON.parse(requests[1]?.init?.body as string)).toEqual({
    slug: "one",
    input: { message: "hello" },
    mode: "sandbox",
  });
  expect(JSON.parse(requests[2]?.init?.body as string)).toEqual({ retryUncertain: false });
  expect(requests[0]?.init?.headers).toEqual({ Authorization: "Bearer session-token" });
});

test("Studio client reports rejected execution instead of returning a run", async () => {
  const request = async () => Response.json({ error: "Run access denied." }, { status: 403 });
  const client = createStudioClient(request, () => null);
  await expect(client.start("one", {}, "full")).rejects.toThrow("Run access denied.");
});
