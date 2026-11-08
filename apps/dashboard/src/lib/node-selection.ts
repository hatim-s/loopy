import { useEffect } from "react";

/**
 * A page's node selection lives in its `node` search param. Escape clears it unless an inner
 * control, such as an open dialog, already handled the key.
 */
export function useNodeSelection(
  selected: string | null,
  setNode: (id: string | undefined) => void,
) {
  const select = (id: string | null) => setNode(id ?? undefined);

  useEffect(() => {
    if (selected === null) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setNode(undefined);
      }
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  });

  return select;
}
