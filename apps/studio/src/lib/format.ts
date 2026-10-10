import type { Command, Json, Workspace } from "loopy";

/** Pretty JSON, falling back to String() for values JSON cannot represent. */
export function formatted(value: Json | Command["env"] | undefined): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function shortDate(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 8) : value;
}

export function workspaceName(workspace: Workspace): string {
  return workspace.kind === "local" ? workspace.path : workspace.id;
}
