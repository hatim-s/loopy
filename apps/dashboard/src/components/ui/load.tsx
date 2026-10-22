import type { ReactNode } from "react";
import type { Lazy, Loaded } from "../../lib/view-models.ts";
import { ErrorBanner } from "../error-banner.tsx";

/**
 * Renders a fetch in its three states. Loading shows `pending` in place, so the frame around it
 * does not jump. Errors show the backend's own message, which names what failed and what to do.
 */
export function Load<T>(props: {
  value: Loaded<T> | Lazy<T>;
  pending: ReactNode;
  children: (data: T, fetching: boolean) => ReactNode;
}) {
  const { value, pending, children } = props;

  switch (value.state) {
    case "idle": {
      return null;
    }

    case "loading": {
      return pending;
    }

    case "error": {
      return <ErrorBanner error={value.error} />;
    }

    default: {
      return children(value.data, value.fetching);
    }
  }
}

/** A muted line for loading and empty states inside panels and tables. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="muted-note">{children}</p>;
}
