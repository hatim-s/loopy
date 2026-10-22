import type { ReactNode } from "react";

export type SegmentOption<V extends string> = { value: V; label: ReactNode; count?: number };

/** One choice from a few. The chosen button carries aria-pressed. */
export function Segmented<V extends string>(props: {
  label: string;
  value: V;
  options: readonly SegmentOption<V>[];
  onChange: (value: V) => void;
}) {
  const { label, value, options, onChange } = props;

  return (
    <div role="group" aria-label={label} className="seg">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && (
            <span className="count">{option.count.toLocaleString()}</span>
          )}
        </button>
      ))}
    </div>
  );
}
