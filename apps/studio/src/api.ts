import type {
  AttemptRecord,
  ExecutionMode,
  RunEvent,
  RunRecord,
  Workflow,
  WorkflowSummary,
} from "loopy";
import { isRecord } from "loopy";

export type RunDetail = {
  run: RunRecord;
  attempts: AttemptRecord[];
  events: RunEvent[];
};

const TOKEN_KEY = "loopy-studio-token";

/** Moves the session token from the URL fragment into session storage. */
export function captureToken(): void {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (!token) {
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, token);
  const url = new URL(window.location.href);
  url.hash = "";
  history.replaceState(null, "", url);
}

async function failureMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (isRecord(body) && typeof body.error === "string") {
    return body.error;
  }
  return `Request failed with status ${response.status}.`;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(await failureMessage(response));
  }
  return response.json();
}

export const endpoints = {
  config: () => api<{ cwd: string }>("/api/config"),
  workflows: () => api<WorkflowSummary[]>("/api/workflows"),
  workflow: (slug: string) => api<Workflow>(`/api/workflows/${encodeURIComponent(slug)}`),
  runs: (slug: string) => api<RunRecord[]>(`/api/runs?slug=${encodeURIComponent(slug)}`),
  run: (id: string) => api<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  start: (slug: string, input: unknown, mode: ExecutionMode) =>
    api<RunRecord>("/api/runs", { slug, input, mode }),
  resume: (id: string, retryUncertain: boolean) =>
    api<RunRecord>(`/api/runs/${encodeURIComponent(id)}/resume`, { retryUncertain }),
};
