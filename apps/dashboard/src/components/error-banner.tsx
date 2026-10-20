import type { ErrorComponentProps } from "@tanstack/react-router";

export function ErrorBanner({ error }: { error: Error }) {
  return (
    <p role="alert" className="border-l-2 border-danger bg-danger/8 px-3 py-2 text-danger">
      {error.message}
    </p>
  );
}

/** A loader or render threw; the router hands over whatever was thrown. */
export function RouteError({ error }: ErrorComponentProps) {
  return (
    <div className="page">
      <ErrorBanner error={error instanceof Error ? error : new Error(String(error))} />
    </div>
  );
}
