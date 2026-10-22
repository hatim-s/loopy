import type { ErrorComponentProps } from "@tanstack/react-router";

export function ErrorBanner({ error }: { error: Error }) {
  return (
    <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-danger">
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
