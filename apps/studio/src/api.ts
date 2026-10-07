import type { AttemptRecord, RunEvent, RunRecord, Workflow } from "loopy";

export type Mode = "sandbox" | "full";
export type WorkflowSummary = {
  slug: string;
  description?: string;
  nodeCount: number;
  updatedAt: string;
  source: string;
};
export type RunDetail = {
  run: RunRecord;
  attempts: AttemptRecord[];
  events: RunEvent[];
};
export type { AttemptRecord, RunEvent, RunRecord, Workflow };

const tokenKey = "loopy-studio-token";

/** Moves the session token from the URL fragment into session storage. */
export function captureToken(): void {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (!token) {
    return;
  }
  sessionStorage.setItem(tokenKey, token);
  const url = new URL(window.location.href);
  url.hash = "";
  history.replaceState(null, "", url);
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const token = sessionStorage.getItem(tokenKey);
  const response = await fetch(path, {
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

export const endpoints = {
  config: () => api<{ cwd: string }>("/api/config"),
  workflows: () => api<WorkflowSummary[]>("/api/workflows"),
  workflow: (slug: string) => api<Workflow>(`/api/workflows/${encodeURIComponent(slug)}`),
  runs: (slug: string) => api<RunRecord[]>(`/api/runs?slug=${encodeURIComponent(slug)}`),
  run: (id: string) => api<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  start: (slug: string, input: unknown, mode: Mode) =>
    api<RunRecord>("/api/runs", { slug, input, mode }),
  resume: (id: string, retryUncertain: boolean) =>
    api<RunRecord>(`/api/runs/${encodeURIComponent(id)}/resume`, { retryUncertain }),
};
