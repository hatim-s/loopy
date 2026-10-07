import { type DependencyList, useEffect } from "react";

type Request<T> = {
  /** Null skips the request for this render, for example while nothing is selected. */
  load: (() => Promise<T>) | null;
  apply: (value: T) => void;
  onError: (cause: unknown) => void;
};

/**
 * Runs `load` whenever `deps` change. A result that lands after the next change
 * or after unmount is dropped, so a slow earlier response never overwrites a newer one.
 */
export function useRequest<T>({ load, apply, onError }: Request<T>, deps: DependencyList): void {
  useEffect(() => {
    if (!load) {
      return;
    }
    let stale = false;
    load()
      .then((value) => {
        if (!stale) {
          apply(value);
        }
      })
      .catch((cause: unknown) => {
        if (!stale) {
          onError(cause);
        }
      });
    return () => {
      stale = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller decides when to reload.
  }, deps);
}
