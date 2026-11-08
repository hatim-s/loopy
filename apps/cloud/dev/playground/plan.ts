import { type Group, groups, type Phase } from "./journal";

// One limit shared by the client's API slots, the provider's backend semaphore and cohort workers.
export const CONCURRENCY = 4;

export const FIXTURES_PER_GROUP = 5;

// Groups a and b lead with one burst fixture; group c has none.
export const burstGroups = { a: true, b: true, c: false } as const satisfies Record<Group, boolean>;

const BURST_RUNS = 100;

const STANDARD_RUNS = 25;

type PlanFixture = { slug: string; burst: boolean; approval: boolean };

export type Job<F extends PlanFixture = PlanFixture> = { fixture: F; ordinal: number };

export function failsAt(phase: Phase, fixture: PlanFixture, ordinal: number) {
  return phase === "primary" && !fixture.approval && ordinal % 6 === 5;
}

export function cohortJobs<F extends PlanFixture>(phase: Phase, fixtures: readonly F[]): Job<F>[] {
  if (phase === "preflight") {
    const [first] = fixtures;

    if (!first) {
      throw new Error("Preflight requires at least one catalog fixture.");
    }

    return [{ fixture: first, ordinal: 0 }];
  }

  return fixtures
    .flatMap((fixture) =>
      [...Array(fixture.burst ? BURST_RUNS : STANDARD_RUNS).keys()].map((ordinal) => ({
        fixture,
        ordinal,
      })),
    )
    .sort((left, right) => left.ordinal - right.ordinal);
}

export function planTotals(catalogs: Record<Group, readonly PlanFixture[]>) {
  const totals = (phase: Phase) => {
    const jobs = groups.flatMap((group) => cohortJobs(phase, catalogs[group]));

    return {
      runs: jobs.length,
      successes: jobs.filter((job) => !failsAt(phase, job.fixture, job.ordinal)).length,
    };
  };

  const preflight = totals("preflight");
  const primary = totals("primary");

  return { preflight, primary, runs: preflight.runs + primary.runs };
}

export type PlanTotals = ReturnType<typeof planTotals>;
