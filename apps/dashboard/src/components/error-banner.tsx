import type { ErrorComponentProps } from "@tanstack/react-router";
import { BackendError } from "../backend/backend";

export function ErrorBanner({ error }: { error: Error }) {
  return (
    <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-danger">
      {error.message}
    </p>
  );
}

/** Server codes stay visible: unknown_hook, for one, means something resolved the hook first. */
export function CodedError({ error }: { error: Error }) {
  return (
    <p role="alert" className="mt-2 rounded-control bg-danger-soft px-3 py-2 text-xs text-danger">
      {error instanceof BackendError && <code className="mr-2 font-mono">{error.code}</code>}
      {error.message}
    </p>
  );
}

/** A loader or render threw; the router hands over whatever was thrown. */
export function RouteError({ error }: ErrorComponentProps) {
  return (
    <div className="content">
      <ErrorBanner error={error instanceof Error ? error : new Error(String(error))} />
    </div>
  );
}
