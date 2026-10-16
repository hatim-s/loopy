import type { EngineRun, EngineRunDetail, Loopy } from "loopy";

const TOKEN_KEY = "loopy-studio-token";

export type LoopySummary = Pick<Loopy, "description" | "scope"> & { slug: string };

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

// BOUNDARY: HTTP error JSON must contain a string error message before Studio displays it.
async function failureMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);

  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }

  return `Request failed with status ${response.status}. Refresh Studio and try again.`;
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY) ?? ""}` },
  });

  if (!response.ok) {
    throw new Error(await failureMessage(response));
  }

  return response.json();
}

export const endpoints = {
  loopies: () => api<LoopySummary[]>("/api/loopies"),
  runs: (slug: string) => api<EngineRun[]>(`/api/runs?slug=${encodeURIComponent(slug)}`),
  run: (id: string) => api<EngineRunDetail>(`/api/runs/${encodeURIComponent(id)}`),
};
