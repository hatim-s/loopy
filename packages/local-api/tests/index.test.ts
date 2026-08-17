import { mkdtempSync, rmSync } from "node:fs";
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
});

test("server config is loopback-only, high-port, and tokenized", () => {
  const config = createLocalServerConfig();
  expect(["127.0.0.1", "::1"]).toContain(config.host);
  expect(config.port).toBeGreaterThanOrEqual(49_152);
  expect(config.token.length).toBeGreaterThan(32);
  expect(() => createLocalServerConfig({ host: "0.0.0.0" as "127.0.0.1" })).toThrow(/loopback/);
});
