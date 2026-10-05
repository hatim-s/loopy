import { createStudioClient } from "../../../packages/loopy/src/local/studio-client.ts";

export type {
  AttemptRecord,
  Mode,
  RunDetail,
  RunRecord,
  Workflow,
  WorkflowSummary,
} from "../../../packages/loopy/src/local/studio-client.ts";

const tokenKey = "loopy-studio-token";

/** Moves the session token from the URL fragment into session storage. */
export function captureToken(): void {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (!token) return;
  sessionStorage.setItem(tokenKey, token);
  const url = new URL(window.location.href);
  url.hash = "";
  history.replaceState(null, "", url);
}

export const endpoints = createStudioClient(fetch, () => sessionStorage.getItem(tokenKey));
