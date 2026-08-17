import { describe, expect, test } from "vitest";
import { createApiClient } from "../src/app/api";
import { createWorkflowEditorAdapter, fallbackWorkflow } from "../src/features/editor";

const workflowId = "11111111-1111-4111-8111-111111111111";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("workflow editor API adapter", () => {
  test("uses version DTOs, patch contracts, validation, and saved-version runs", async () => {
    const initial = fallbackWorkflow(workflowId);
    const saved = { ...initial, workflowVersion: 2 };
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const api = createApiClient({
      baseUrl: "/api/v1",
      fetcher: async (input, init) => {
        const url = String(input);
        const path = url.replace("/api/v1", "");
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : undefined;
        calls.push({ path, ...(body ? { body } : {}) });
        if (path === `/workflows/${workflowId}`)
          return response({
            workflowId,
            versions: [{ workflowId, version: 1, definition: initial }],
          });
        if (path === `/workflows/${workflowId}/1`)
          return response({ workflowId, version: 1, definition: initial });
        if (path === `/workflows/${workflowId}/patch`)
          return response({ workflowId, version: 2, definition: saved }, 201);
        if (path === `/workflows/${workflowId}/validate`)
          return response({ valid: true, diagnostics: [] });
        if (path === "/runs") return response({ id: "run-2" }, 201);
        return response({ error: "not found" }, 404);
      },
    });
    const adapter = createWorkflowEditorAdapter(api);
    const loaded = await adapter.load(workflowId);
    expect(loaded.version).toBe(1);
    const changed = structuredClone(initial);
    const agent = changed.nodes.find((node) => node.kind === "agent");
    if (!agent || agent.kind !== "agent") throw new Error("fixture agent missing");
    agent.provider = "pi";
    agent.model = "pi-model";
    const version = await adapter.save({
      workflowId,
      baseVersion: loaded.version,
      definition: changed,
      summary: "provider edit",
    });
    expect(version.version).toBe(2);
    expect(calls.find((call) => call.path.endsWith("/patch"))?.body).toMatchObject({
      baseVersion: 1,
    });
    expect(
      (calls.find((call) => call.path.endsWith("/patch"))?.body?.operations as unknown[]).some(
        (operation) => (operation as { op?: string }).op === "replace_node",
      ),
    ).toBe(true);
    expect((await adapter.validate(changed)).valid).toBe(true);
    expect(await adapter.run(workflowId, 2, { input: "ok" })).toEqual({ id: "run-2" });
    expect(calls.map((call) => call.path)).toEqual([
      `/workflows/${workflowId}`,
      `/workflows/${workflowId}/1`,
      `/workflows/${workflowId}/patch`,
      `/workflows/${workflowId}/validate`,
      "/runs",
    ]);
  });
});
