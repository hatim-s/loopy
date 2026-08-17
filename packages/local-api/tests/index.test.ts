import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@loopy/storage";
import { describe, expect, test } from "vitest";
import { createLocalApi, createLocalServerConfig } from "../src/index";

const token = "test-token-012345678901234567890123456789";
const headers = { Authorization: `Bearer ${token}` };

function project() {
  const dir = mkdtempSync(join(tmpdir(), "loopy-local-api-"));
  const storage = new Storage({ projectDir: dir, acquireLock: false });
  return { dir, storage };
}

describe("local API", () => {
  test("requires bearer auth and exact origin allowlist", async () => {
    const { dir, storage } = project();
    try {
      const app = createLocalApi({ storage, token, origins: ["http://studio.local"] });
      expect((await app.request("/api/v1/health")).status).toBe(401);
      expect(
        (
          await app.request("/api/v1/health", {
            headers: { ...headers, Origin: "http://evil.local" },
          })
        ).status,
      ).toBe(403);
      const response = await app.request("/api/v1/health", {
        headers: { ...headers, Origin: "http://studio.local" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://studio.local");
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects weak bearer tokens and hides unexpected server errors", async () => {
    const { dir, storage } = project();
    try {
      expect(() => createLocalApi({ storage, token: "too-short" })).toThrow(/32 characters/);
      expect(() => createLocalServerConfig({ token: "too-short" })).toThrow(/32 characters/);

      storage.runtime.listProviderInstallations = () => {
        throw new Error("database password should not cross the API boundary");
      };
      const app = createLocalApi({ storage, token });
      const response = await app.request("/api/v1/providers", { headers });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: "internal_error", message: "Internal server error" },
      });
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enforces body limits while reading a streamed request", async () => {
    const { dir, storage } = project();
    try {
      let cancelled = false;
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(pulls === 1 ? new Uint8Array([123]) : new Uint8Array(64).fill(32));
        },
        cancel() {
          cancelled = true;
        },
      });
      const app = createLocalApi({ storage, token, maxBodyBytes: 8 });
      const response = await app.request("/api/v1/workflows", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit);
      expect(response.status).toBe(413);
      expect((await response.json()).error.code).toBe("body_too_large");
      expect(pulls).toBe(2);
      expect(cancelled).toBe(true);
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lists versioned provider/session/workflow resources", async () => {
    const { dir, storage } = project();
    try {
      storage.runtime.createImportedSession({ provider: "codex", source: "fixture", session: [] });
      const app = createLocalApi({ storage, token });
      const sessions = await app.request("/api/v1/sessions", { headers });
      expect(sessions.status).toBe(200);
      expect((await sessions.json()).sessions).toHaveLength(1);
      expect((await app.request("/v1/providers", { headers })).status).toBe(200);
      expect((await app.request("/api/v1/workflows", { headers })).status).toBe(200);
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns explicit capability errors for absent replay seam", async () => {
    const { dir, storage } = project();
    try {
      const workflow = { id: "workflow-1", workflowVersion: 1, name: "test", nodes: [], edges: [] };
      storage.runtime.createWorkflowVersion({
        workflowId: workflow.id,
        version: 1,
        definition: workflow,
      });
      const run = storage.runtime.createRun({ workflowId: workflow.id, workflowVersion: 1 });
      const app = createLocalApi({ storage, token });
      const response = await app.request(`/api/v1/runs/${run.id}/replay`, {
        method: "POST",
        headers,
      });
      expect(response.status).toBe(501);
      expect((await response.json()).error.code).toBe("capability_unavailable");
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resumes SSE after Last-Event-ID and closes on disconnect", async () => {
    const { dir, storage } = project();
    try {
      const workflow = { id: "workflow-2", workflowVersion: 1, name: "test", nodes: [], edges: [] };
      storage.runtime.createWorkflowVersion({
        workflowId: workflow.id,
        version: 1,
        definition: workflow,
      });
      const run = storage.runtime.createRun({ workflowId: workflow.id, workflowVersion: 1 });
      storage.runtime.appendEvent(run.id, { type: "run.started", payload: { planHash: "hash" } });
      const app = createLocalApi({ storage, token, heartbeatMs: 1_000, pollMs: 25 });
      const response = await app.request(`/api/v1/runs/${run.id}/events/stream`, {
        headers: { ...headers, "Last-Event-ID": "0" },
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      if (!reader) throw new Error("SSE response did not provide a reader");
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      const second = await reader.read();
      const combined = text + new TextDecoder().decode(second.value);
      expect(combined).toContain("run.started");
      await reader.cancel();
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses one run shape and keeps canonical event identity and provenance", async () => {
    const { dir, storage } = project();
    try {
      const workflow = {
        id: "workflow-contract",
        workflowVersion: 1,
        name: "test",
        nodes: [],
        edges: [],
      };
      storage.runtime.createWorkflowVersion({
        workflowId: workflow.id,
        version: 1,
        definition: workflow,
      });
      const run = storage.runtime.createRun({ workflowId: workflow.id, workflowVersion: 1 });
      storage.runtime.appendEvent(run.id, {
        id: "event-canonical-1",
        type: "provider.message",
        provider: "codex",
        sessionId: "session-1",
        toolCallId: "tool-1",
        monotonicOffsetMs: 42,
        payload: { text: "hello" },
      });
      const app = createLocalApi({ storage, token });
      const listed = await app.request("/api/v1/runs", { headers });
      const created = (await listed.json()).runs[0];
      const snapshot = await app.request(`/api/v1/runs/${run.id}`, { headers });
      const body = await snapshot.json();
      expect(created).toMatchObject({
        id: run.id,
        workflowId: workflow.id,
        workflowVersion: 1,
        input: {},
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
      expect(body).toMatchObject({
        id: run.id,
        workflowId: workflow.id,
        workflowVersion: 1,
        status: run.status,
        attempts: [],
      });
      expect(
        body.events.find((event: { id?: string }) => event.id === "event-canonical-1"),
      ).toMatchObject({
        id: "event-canonical-1",
        sequence: 1,
        provider: "codex",
        sessionId: "session-1",
        toolCallId: "tool-1",
        monotonicOffsetMs: 42,
      });
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exposes workflow-version topology for the debugger graph", async () => {
    const { dir, storage } = project();
    try {
      const workflow = {
        id: "workflow-topology",
        workflowVersion: 1,
        name: "topology",
        nodes: [{ id: "start" }, { id: "finish" }],
        edges: [{ id: "edge", source: "start", target: "finish" }],
      };
      storage.runtime.createWorkflowVersion({
        workflowId: workflow.id,
        version: 1,
        definition: workflow,
      });
      const app = createLocalApi({ storage, token });
      const response = await app.request(`/api/v1/workflows/${workflow.id}/1/topology`, {
        headers,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        workflowId: workflow.id,
        version: 1,
        topology: {
          startNodeIds: ["start"],
          terminalNodeIds: ["finish"],
          topologicalOrder: ["start", "finish"],
        },
      });
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("normalizes scheduler-backed create/get responses to the persisted run DTO", async () => {
    const { dir, storage } = project();
    try {
      const workflow = {
        id: "workflow-runtime",
        workflowVersion: 1,
        name: "runtime",
        nodes: [],
        edges: [],
      };
      storage.runtime.createWorkflowVersion({
        workflowId: workflow.id,
        version: 1,
        definition: workflow,
      });
      const runtimeRun = {
        runId: "runtime-run-1",
        workflowId: workflow.id,
        workflowVersion: 1,
        plan: { workflowId: workflow.id, workflowVersion: 1, nodes: [], edges: [] },
        executionPlanHash: "runtime-plan-hash",
        inputs: { source: "scheduler" },
        status: "running" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
      };
      const runtimeEvent = {
        sequence: 0,
        type: "run.started",
        runId: runtimeRun.runId,
        payload: { planHash: runtimeRun.executionPlanHash },
        occurredAt: runtimeRun.startedAt,
      };
      const scheduler = {
        start: async () => runtimeRun,
        snapshot: async () => ({
          run: runtimeRun,
          attempts: [],
          events: [runtimeEvent],
          approvals: [],
        }),
      } as unknown as import("@loopy/runtime").RuntimeScheduler;
      const app = createLocalApi({ storage, scheduler, token });
      const createdResponse = await app.request("/api/v1/runs", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId: workflow.id, version: 1, input: runtimeRun.inputs }),
      });
      const created = await createdResponse.json();
      const fetched = await app.request(`/api/v1/runs/${runtimeRun.runId}`, { headers });
      const body = await fetched.json();
      expect(createdResponse.status).toBe(201);
      expect(created).toMatchObject({
        id: runtimeRun.runId,
        workflowId: workflow.id,
        input: runtimeRun.inputs,
        planHash: runtimeRun.executionPlanHash,
        updatedAt: runtimeRun.startedAt,
      });
      expect(body).toMatchObject({
        id: created.id,
        workflowId: created.workflowId,
        status: created.status,
        input: created.input,
        planHash: created.planHash,
        events: [{ id: `${runtimeRun.runId}:0:run.started::`, sequence: 0 }],
      });
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("server config is loopback-only, high-port, and tokenized", () => {
  const config = createLocalServerConfig();
  expect(["127.0.0.1", "::1"]).toContain(config.host);
  expect(config.port).toBeGreaterThanOrEqual(49_152);
  expect(config.token.length).toBeGreaterThan(32);
  expect(() => createLocalServerConfig({ host: "0.0.0.0" as "127.0.0.1" })).toThrow(/loopback/);
});

describe("workflow editing API", () => {
  const workflow = () =>
    JSON.parse(
      readFileSync(join(import.meta.dir, "../../../fixtures/workflows/valid-basic.json"), "utf8"),
    ) as Record<string, unknown>;

  test("patches provider/model, adds and removes nodes, edits verification, protects versions, diffs, and runs v2", async () => {
    const { dir, storage } = project();
    try {
      const base = workflow();
      const workflowId = base.id as string;
      const agentId = (base.nodes as Array<{ id: string }>)[0]?.id as string;
      const verifyId = (base.nodes as Array<{ id: string }>)[1]?.id as string;
      storage.runtime.createWorkflowVersion({
        workflowId,
        version: 1,
        definition: base as import("@loopy/contracts").JsonObject,
      });
      const started: Record<string, unknown>[] = [];
      const scheduler = {
        start: async (definition: Record<string, unknown>, input: Record<string, unknown>) => {
          started.push(definition);
          return {
            runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            workflowId: definition.id,
            workflowVersion: definition.workflowVersion,
            plan: definition,
            inputs: input,
            status: "running" as const,
            createdAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:01.000Z",
          };
        },
      } as unknown as import("@loopy/runtime").RuntimeScheduler;
      const app = createLocalApi({ storage, scheduler, token });
      const patch = async (baseVersion: number, operations: unknown[]) =>
        app.request(`/api/v1/workflows/${workflowId}/patch`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ baseVersion, operations }),
        });

      const v2Response = await patch(1, [
        { op: "set_node_provider", nodeId: agentId, provider: "pi" },
        { op: "set_node_model", nodeId: agentId, model: "test-model" },
      ]);
      expect(v2Response.status).toBe(201);
      expect((await v2Response.json()).version).toBe(2);

      const addedNode = "55555555-5555-4555-8555-555555555555";
      const addedEdge = "66666666-6666-4666-8666-666666666666";
      const v3Response = await patch(2, [
        {
          op: "add_node",
          node: {
            id: addedNode,
            kind: "verify",
            name: "Extra verification",
            commands: [{ command: "true", args: [], timeoutMs: 120000 }],
            success: "all",
            expectedExitCode: 0,
            tags: [],
          },
        },
        {
          op: "add_edge",
          edge: { id: addedEdge, source: verifyId, target: addedNode, metadata: {} },
        },
      ]);
      expect(v3Response.status).toBe(201);

      const v4Response = await patch(3, [{ op: "remove_node", nodeId: addedNode }]);
      expect(v4Response.status).toBe(201);
      const v5Response = await patch(4, [
        {
          op: "set_verification",
          nodeId: verifyId,
          commands: [{ command: "true", args: [], timeoutMs: 120000 }],
          success: "all",
          expectedExitCode: 0,
        },
      ]);
      expect(v5Response.status).toBe(201);

      const invalid = await patch(5, [{ op: "set_node_prompt", nodeId: verifyId, prompt: "nope" }]);
      expect(invalid.status).toBe(422);
      expect(storage.runtime.listWorkflowVersions(workflowId)).toHaveLength(5);
      const stale = await patch(1, [{ op: "set_workflow_name", name: "stale" }]);
      expect(stale.status).toBe(409);
      const bothPatchAliases = await app.request(`/api/v1/workflows/${workflowId}/patch`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          baseVersion: 5,
          operations: [{ op: "set_workflow_name", name: "canonical" }],
          patch: [{ op: "set_workflow_name", name: "alias" }],
        }),
      });
      expect(bothPatchAliases.status).toBe(422);
      expect(storage.runtime.listWorkflowVersions(workflowId)).toHaveLength(5);

      const diff = await app.request(`/api/v1/workflows/${workflowId}/diff?from=1&to=2`, {
        headers,
      });
      expect(diff.status).toBe(200);
      expect((await diff.json()).changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: `/nodes/${agentId}/provider`, after: "pi" }),
          expect.objectContaining({ path: `/nodes/${agentId}/model`, after: "test-model" }),
        ]),
      );

      const run = await app.request("/api/v1/runs", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId, workflowVersion: 2, input: { task: "test" } }),
      });
      expect(run.status).toBe(201);
      expect((await run.json()).workflowVersion).toBe(2);
      expect(started[0]?.workflowVersion).toBe(2);

      const legacyId = "77777777-7777-4777-8777-777777777777";
      const legacy = structuredClone(base);
      legacy.id = legacyId;
      delete legacy.triggers;
      storage.runtime.createWorkflowVersion({
        workflowId: legacyId,
        version: 1,
        definition: legacy as import("@loopy/contracts").JsonObject,
      });
      const normalizedExport = await app.request(`/api/v1/workflows/${legacyId}/1/export`, {
        headers,
      });
      expect(normalizedExport.status).toBe(200);
      expect((await normalizedExport.json()).triggers).toEqual({ manual: true });

      const corruptId = "88888888-8888-4888-8888-888888888888";
      storage.runtime.createWorkflowVersion({
        workflowId: corruptId,
        version: 1,
        definition: {
          id: corruptId,
          workflowVersion: 1,
          name: "corrupt legacy workflow",
          nodes: [],
          edges: [],
        },
      });
      const invalidExport = await app.request(`/api/v1/workflows/${corruptId}/1/export`, {
        headers,
      });
      expect(invalidExport.status).toBe(422);
      expect(await invalidExport.json()).toMatchObject({
        error: {
          code: "workflow_export_invalid",
          message: "Stored workflow definition failed validation",
        },
      });
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
