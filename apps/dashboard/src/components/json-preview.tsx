import type { Json } from "loopy/contract";

const INLINE_LIMIT = 160;

/** A one-line preview that expands to the whole value. */
export function JsonPreview({ label, value }: { label: string; value: Json }) {
  const text = JSON.stringify(value);

  return (
    <details className="group min-w-0">
      <summary className="flex cursor-pointer gap-2 marker:text-muted">
        <span className="shrink-0 text-muted">{label}</span>
        <code className="truncate group-open:hidden">
          {text.length > INLINE_LIMIT ? `${text.slice(0, INLINE_LIMIT)}…` : text}
        </code>
      </summary>
      <JsonBlock value={value} />
    </details>
  );
}

/** A value printed in full, in a bounded scroll box so a large payload does not push the page. */
export function JsonBlock({ value }: { value: Json }) {
  return (
    <pre className="mt-1.5 max-h-80 overflow-auto rounded-control border border-line bg-sunken p-2.5 font-mono text-xs leading-[18px]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
