import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { qualityTestRoot } from "../../../../../packages/loopy/_tests_/fixtures/quality-test-root";
import { type Admission, groups, phases } from "../../../dev/playground/journal";
import { cohortJobs, failsAt, planTotals } from "../../../dev/playground/plan";
import { receiptInventory } from "../../../dev/playground/receipt/inventory";

const batch = "synthetic-architecture";

function fixtures(group: string, burst: boolean, approvals: number) {
  return [...Array(5).keys()].map((index) => ({
    slug: `${group}-fixture-${index}`,
    burst: burst && index === 0,
    approval: index >= 5 - approvals,
  }));
}

const catalogs = {
  a: fixtures("a", true, 0),
  b: fixtures("b", true, 1),
  c: fixtures("c", false, 3),
};

const plan = planTotals(catalogs);

const admissions: Admission[] = groups.flatMap((group) =>
  phases.flatMap((phase) =>
    cohortJobs(phase, catalogs[group]).map(({ fixture, ordinal }) => {
      const fail = failsAt(phase, fixture, ordinal);

      return {
        slug: fixture.slug,
        group,
        phase,
        input: {
          batch: phase === "primary" ? batch : `${batch}-preflight`,
          ordinal,
          fail,
          items: [],
        },
        expected: fail ? "failed" : "succeeded",
        intentAt: "2026-10-23T00:00:00Z",
        admittedAt: "2026-10-23T00:00:01Z",
        runId: `${phase}-${fixture.slug}-${ordinal}`,
      };
    }),
  ),
);

const file = (admission: Admission) =>
  `${admission.phase}/${admission.group}/${admission.slug}-${admission.input.ordinal}.json`;

test("receipt inventory derives identities and outcomes from every planned admission", async () => {
  const journal = await qualityTestRoot("receipt-inventory");

  try {
    for (const value of admissions) {
      await Bun.write(resolve(journal, file(value)), JSON.stringify(value));
    }

    const runs = admissions.map((value) => ({
      id: value.runId ?? "",
      slug: value.slug,
      status: value.expected,
      createdAt: value.intentAt,
      updatedAt: value.intentAt,
    }));

    const options = { inventory: { batch, runs }, plan, batch, journal };
    expect((await receiptInventory(options)).size).toBe(plan.runs);
    await expect(
      receiptInventory({ ...options, inventory: { batch, runs: runs.slice(0, 1) } }),
    ).rejects.toThrow(`${plan.runs} unique`);
    await expect(
      receiptInventory({
        ...options,
        inventory: {
          batch,
          runs: runs.map((run, index) => (index === 1 ? { ...run, id: runs[0]?.id ?? "" } : run)),
        },
      }),
    ).rejects.toThrow(`${plan.runs} unique`);
    await expect(receiptInventory({ ...options, batch: "foreign" })).rejects.toThrow(
      "current-batch",
    );

    const original = admissions.find((value) => value.phase === "primary");
    const preflight = admissions.find((value) => value.phase === "preflight");

    if (!original || !preflight) {
      throw new Error("The plan must produce primary and preflight admissions.");
    }

    for (const changed of [
      { ...original, runId: null },
      { ...original, runId: preflight.runId },
      { ...original, admittedAt: null },
      { ...original, expected: original.expected === "failed" ? "succeeded" : "failed" },
      { ...original, input: { ...original.input, batch: "foreign" } },
    ]) {
      await Bun.write(resolve(journal, file(original)), JSON.stringify(changed));
      await expect(receiptInventory(options)).rejects.toThrow("mismatched admission");
    }

    await rm(resolve(journal, file(original)));
    await expect(receiptInventory(options)).rejects.toThrow("incomplete primary");
    await Bun.write(resolve(journal, file(original)), JSON.stringify(original));
    await rm(resolve(journal, file(preflight)));
    await expect(receiptInventory(options)).rejects.toThrow("incomplete preflight");
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});
