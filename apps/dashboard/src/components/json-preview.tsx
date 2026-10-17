import type { Json } from "loopy/contract";

const INLINE_LIMIT = 160;

export function JsonPreview({ label, value }: { label: string; value: Json }) {
  const text = JSON.stringify(value);

  return (
    <details className="group min-w-0">
      <summary className="flex cursor-pointer gap-2 marker:text-muted">
        <span className="shrink-0 text-muted">{label}</span>
        <code className="truncate font-mono text-xs group-open:hidden">
          {text.length > INLINE_LIMIT ? `${text.slice(0, INLINE_LIMIT)}…` : text}
        </code>
      </summary>
      <pre className="mt-1.5 overflow-x-auto rounded border border-line bg-page p-3 font-mono text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
