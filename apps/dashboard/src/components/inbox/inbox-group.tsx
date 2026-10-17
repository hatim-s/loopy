import type { InboxGroup as Group } from "../../lib/inbox.ts";
import { InboxRow } from "./inbox-row.tsx";

export function InboxGroup({ group, now }: { group: Group; now: number }) {
  const headingId = `inbox-${group.slug}`;

  return (
    <section aria-labelledby={headingId} className="space-y-1.5">
      <h2 id={headingId} className="flex items-baseline gap-2">
        <span className="font-medium">{group.slug}</span>
        <span className="text-xs text-muted tabular-nums">{group.runs.length} waiting</span>
      </h2>
      <ul className="space-y-1">
        {group.runs.map((run) => (
          <InboxRow key={run.waitingOn.token} run={run} now={now} />
        ))}
      </ul>
    </section>
  );
}
