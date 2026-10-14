import { useEffect, useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }

    const id = setTimeout(() => setCopied(false), 1600);

    return () => clearTimeout(id);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }

    setCopied(true);
  };

  return (
    <button className="copy" type="button" onClick={copy} data-copied={copied ? "" : undefined}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
