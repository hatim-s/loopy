import { useState } from "react";
import { parseJsonInput } from "../lib/input-form";

export function useJsonText(initial: string) {
  const [text, setText] = useState(initial);

  return { text, setText, parsed: parseJsonInput(text) };
}

/** A JSON textarea that marks itself invalid and says so under the field. */
export function JsonField(props: {
  label: string;
  noun: string;
  json: ReturnType<typeof useJsonText>;
  rows: number;
  rejected?: boolean;
}) {
  const { label, noun, json, rows, rejected = false } = props;

  return (
    <label className="block space-y-1">
      <span className="block text-xs text-muted">{label}</span>
      <textarea
        value={json.text}
        onChange={(event) => json.setText(event.target.value)}
        rows={rows}
        spellCheck={false}
        aria-invalid={!json.parsed.valid || rejected}
        className="field"
      />
      {!json.parsed.valid && (
        <span className="block text-xs text-danger">The {noun} is not valid JSON.</span>
      )}
    </label>
  );
}
