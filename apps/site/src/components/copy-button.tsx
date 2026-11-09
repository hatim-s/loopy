import { useEffect, useState } from "react";

const LABEL = { idle: "Copy", copied: "Copied", failed: "Copy failed" } as const;

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<keyof typeof LABEL>("idle");
  useEffect(() => {
    if (state === "idle") {
      return;
    }

    const id = setTimeout(() => setState("idle"), 1600);

    return () => clearTimeout(id);
  }, [state]);

  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => setState("copied"),
      () => setState("failed"),
    );

  return (
    <button
      className="copy"
      type="button"
      onClick={copy}
      data-copied={state === "copied" ? "" : undefined}
    >
      {LABEL[state]}
    </button>
  );
}
