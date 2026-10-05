import type { AttemptRecord, Json, RunEvent, RunRecord, Workflow } from "../core/model.js";
import type { WorkflowSummary } from "./registry.js";
export type Mode = "sandbox" | "full";
export type RunDetail = { run: RunRecord; attempts: AttemptRecord[]; events: RunEvent[] };
export type { AttemptRecord, RunEvent, RunRecord, Workflow, WorkflowSummary };

export function createStudioClient(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  getToken: () => string | null,
) {
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const token = getToken();
    const response = await request(path, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(failure?.error ?? `Request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
  }

  return {
    config: () => api<{ cwd: string }>("/api/config"),
    workflows: () => api<WorkflowSummary[]>("/api/workflows"),
    workflow: (slug: string) => api<Workflow>(`/api/workflows/${encodeURIComponent(slug)}`),
    runs: (slug: string) => api<RunRecord[]>(`/api/runs?slug=${encodeURIComponent(slug)}`),
    run: (id: string) => api<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
    start: (slug: string, input: Json, mode: Mode) =>
      api<RunRecord>("/api/runs", { slug, input, mode }),
    resume: (id: string, retryUncertain: boolean) =>
      api<RunRecord>(`/api/runs/${encodeURIComponent(id)}/resume`, { retryUncertain }),
  };
}
