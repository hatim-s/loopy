import type { AttemptRecord, RunEvent, RunRecord, Workflow } from "loopy";

export type WorkflowSummary = {
  slug: string;
  description?: string;
  nodeCount: number;
  updatedAt: string;
};

export type RunDetail = {
  run: RunRecord;
  attempts: AttemptRecord[];
  events: RunEvent[];
};

export type { AttemptRecord, RunEvent, RunRecord, Workflow };

const tokenKey = "loopy-studio-token";

export function captureToken(): void {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const token = hash.get("token");
  if (!token) return;
  sessionStorage.setItem(tokenKey, token);
  const url = new URL(window.location.href);
  url.hash = "";
  history.replaceState(null, "", url);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = sessionStorage.getItem(tokenKey);
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const endpoints = {
  config: () => api<{ cwd: string }>("/api/config"),
  workflows: () => api<WorkflowSummary[]>("/api/workflows"),
  workflow: (slug: string) => api<Workflow>(`/api/workflows/${encodeURIComponent(slug)}`),
  runs: (slug: string) => api<RunRecord[]>(`/api/runs?slug=${encodeURIComponent(slug)}`),
  run: (id: string) => api<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  start: (slug: string, input: unknown, mode: "sandbox" | "full") =>
    api<RunRecord>("/api/runs", { method: "POST", body: JSON.stringify({ slug, input, mode }) }),
  resume: (id: string, retryUncertain: boolean) =>
    api<RunRecord>(`/api/runs/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      body: JSON.stringify({ retryUncertain }),
    }),
};
