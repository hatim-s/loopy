import { useLoopyRows } from "../lib/ui-data";

/** A filter over every saved loopy by slug; the empty option clears it. */
export function LoopySelect(props: {
  value: string | undefined;
  onChange: (slug: string | undefined) => void;
}) {
  const { value, onChange } = props;
  const loopies = useLoopyRows();

  return (
    <select
      className="field"
      aria-label="Loopy"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || undefined)}
    >
      <option value="">All loopies</option>
      {loopies.state === "ready" &&
        loopies.data.map((loopy) => (
          <option key={`${loopy.workspace}:${loopy.slug}`} value={loopy.slug}>
            {loopy.slug}
          </option>
        ))}
    </select>
  );
}
