import { createFileRoute } from "@tanstack/react-router";
import { LoopyTable } from "../components/loopy-table.tsx";
import { RunList } from "../components/run-list.tsx";
import { useClock } from "../lib/clock.ts";

export const Route = createFileRoute("/")({ component: Home });

const ALL_RUNS = {} as const;

function Home() {
  const now = useClock();

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-6">
      <section aria-labelledby="loopies-heading" className="space-y-3">
        <h1 id="loopies-heading" className="text-base font-semibold">
          Loopies
        </h1>
        <LoopyTable now={now} />
      </section>
      <section aria-labelledby="runs-heading" className="space-y-3">
        <h2 id="runs-heading" className="text-base font-semibold">
          Recent runs
        </h2>
        <RunList
          filters={ALL_RUNS}
          now={now}
          withLoopy
          empty="No runs yet. Start one from a loopy's page or with loopy run <slug>."
        />
      </section>
    </div>
  );
}
