import { useCallback, useState } from "react";

type Entry<T> = { scope: string | null; value: T };

/**
 * State that falls back to `fallback` whenever `scope` changes, without a reset
 * effect. Used for selections that belong to one workflow or one run.
 */
export function useScopedState<T>(
  scope: string | null,
  fallback: T,
): [value: T, set: (value: T) => void] {
  const [entry, setEntry] = useState<Entry<T> | null>(null);
  const value = entry && entry.scope === scope ? entry.value : fallback;
  const set = useCallback((next: T) => setEntry({ scope, value: next }), [scope]);
  return [value, set];
}
