import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkflowDefinitionSchema } from "@loopy/contracts";
import type {
  ExtractionJobRecord,
  ExtractionReviewRecord,
  ImportedSessionRecord,
  WorkflowVersionRecord,
} from "@loopy/storage";
import { startServer } from "../src/index";

test("server imports a trace, extracts evidence, and publishes only after review", async () => {
  const project = mkdtempSync(resolve(tmpdir(), "loopy-extraction-"));
  writeFileSync(resolve(project, "index.html"), "<html><head></head></html>");
  const server = await startServer({ projectDir: project, studioDir: project });
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result as T;
  };
  try {
    const events = (await Bun.file(
      new URL("../../../fixtures/sessions/successful.json", import.meta.url),
    ).json()) as unknown[];
    const input = {
      provider: "codex",
      source: "successful.json",
      content: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    };
    const session = await api<ImportedSessionRecord>("/sessions", input);
    expect((await api<ImportedSessionRecord>("/sessions", input)).id).toBe(session.id);
    await expect(api("/sessions", { ...input, content: "not a trace\n" })).rejects.toThrow(
      "invalid_session",
    );
    const job = await api<ExtractionJobRecord>("/extractions", { importId: session.id });
    expect(job.status).toBe("succeeded");
    const review = await api<ExtractionReviewRecord>(`/extractions/${job.id}`);
    expect(review.proposal.nodeEvidence.length).toBeGreaterThan(0);
    expect((await api<{ workflows: unknown[] }>("/workflows")).workflows).toHaveLength(0);
    const published = await api<WorkflowVersionRecord>(`/extractions/${job.id}/approve`, {});
    expect(WorkflowDefinitionSchema.parse(published.definition).nodes.length).toBeGreaterThan(0);
    expect((await api<{ workflows: unknown[] }>("/workflows")).workflows).toHaveLength(1);
    const rejected = await api<ExtractionJobRecord>("/extractions", { importId: session.id });
    await api(`/extractions/${rejected.id}/reject`, { reason: "Choose the first proposal" });
    expect((await api<ExtractionReviewRecord>(`/extractions/${rejected.id}`)).proposal.status).toBe(
      "rejected",
    );
    expect((await api<{ workflows: unknown[] }>("/workflows")).workflows).toHaveLength(1);
  } finally {
    await server.stop();
    rmSync(project, { recursive: true, force: true });
  }
});
