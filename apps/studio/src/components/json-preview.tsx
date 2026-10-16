import type { Json } from "loopy";

export function JsonPreview({ label, value }: { label: string; value: Json }) {
  const text = JSON.stringify(value);

  return (
    <details className="json-preview">
      <summary>
        <span>{label}</span>{" "}
        <code>
          {text.slice(0, 200)}
          {text.length > 200 ? "…" : ""}
        </code>
      </summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
