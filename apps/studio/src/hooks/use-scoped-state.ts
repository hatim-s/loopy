import { useCallback, useState } from "react";

type Entry<T> = { scope: string | null; value: T };

/**
 * State that belongs to one scope (a workflow slug, a run id). Leaving the scope
 * discards the value, so coming back starts from `fallback` again.
 */
export function useScopedState<T>(
  scope: string | null,
  fallback: T,
): [value: T, set: (value: T) => void] {
  const [entry, setEntry] = useState<Entry<T> | null>(null);
  if (entry && entry.scope !== scope) {
    // Resetting during render is React's pattern for state derived from a changed prop.
    setEntry(null);
  }
  const value = entry && entry.scope === scope ? entry.value : fallback;
  const set = useCallback((next: T) => setEntry({ scope, value: next }), [scope]);
  return [value, set];
}
