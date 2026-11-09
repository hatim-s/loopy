export const selected = [
  { group: "a", slug: "playground-a-lint-report" },
  { group: "b", slug: "playground-b-parallel-build" },
  { group: "b", slug: "playground-b-retry-marker" },
  { group: "c", slug: "playground-c-repository-validation" },
  { group: "c", slug: "playground-c-security-review" },
] as const;

const ordinals = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const PLANNED_RUNS = selected.length * ordinals.length;

export const DAEMON = { leaseMs: 2000, concurrency: 4 } as const;

const FAIL_ORDINAL = 5;

const DENY_ORDINAL = 8;

export function runInput(ordinal: number) {
  return {
    batch: `playground-daemon-${PLANNED_RUNS}`,
    ordinal,
    fail: ordinal === FAIL_ORDINAL,
    items: [3, 7, 11, ordinal],
  };
}

export function approves(ordinal: number) {
  return ordinal !== DENY_ORDINAL;
}

// Staggered holds keep approval resolution from landing on the same poll tick every time.
export function holdMs(ordinal: number) {
  return 10_000 + (ordinal % 3) * 1000;
}

// The approval workflow runs first so the restart proof happens while a hook is waiting.
export function loadPlan<E extends { slug: string; approval: boolean }>(entries: readonly E[]) {
  const approval = entries.find((entry) => entry.approval);

  if (!approval) {
    throw new Error("The selected catalog has no approval workflow.");
  }

  return [
    { entry: approval, ordinal: 1 },
    ...entries
      .flatMap((entry) => ordinals.map((ordinal) => ({ entry, ordinal })))
      .filter(({ entry, ordinal }) => entry.slug !== approval.slug || ordinal !== 1),
  ];
}
