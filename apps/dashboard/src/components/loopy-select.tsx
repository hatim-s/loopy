import type { LoopyView } from "@loopy/contract";
import { useLoopyRows } from "../lib/ui-data";

/** A loopy is one slug in one workspace; a global definition is the same slug everywhere. */
export type LoopyTarget = { slug?: string; workspace?: string };

export function loopyTarget(loopy: LoopyView): LoopyTarget {
  return { slug: loopy.slug, workspace: loopy.scope === "global" ? undefined : loopy.workspace };
}

function targetKey(target: LoopyTarget): string {
  return target.slug === undefined ? "" : JSON.stringify([target.workspace ?? null, target.slug]);
}

/** A filter over every saved loopy; the empty option clears it. */
export function LoopySelect(props: {
  value: LoopyTarget;
  onChange: (target: LoopyTarget) => void;
}) {
  const { value, onChange } = props;
  const loopies = useLoopyRows();
  const rows = loopies.state === "ready" ? loopies.data : [];

  const shared = new Set(
    rows
      .filter((row, index) => rows.findIndex((other) => other.slug === row.slug) !== index)
      .map((row) => row.slug),
  );

  return (
    <select
      className="field"
      aria-label="Loopy"
      value={targetKey(value)}
      onChange={(event) =>
        onChange(
          rows.map(loopyTarget).find((target) => targetKey(target) === event.target.value) ?? {},
        )
      }
    >
      <option value="">All loopies</option>
      {rows.map((loopy) => (
        <option key={targetKey(loopyTarget(loopy))} value={targetKey(loopyTarget(loopy))}>
          {shared.has(loopy.slug) && loopy.scope !== "global"
            ? `${loopy.slug} (${loopy.workspace})`
            : loopy.slug}
        </option>
      ))}
    </select>
  );
}
