import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Admission } from "../journal";
import { receiptInventory } from "../receipt/inventory";

const batch = "synthetic-architecture";

function admission(index: number): Admission {
  const phase = index < 525 ? "primary" : "preflight";

  return {
    group: "a",
    slug: `fixture-${index}`,
    phase,
    input: {
      batch: phase === "primary" ? batch : `${batch}-preflight`,
      ordinal: index,
      fail: index >= 461 && index < 525,
      items: [],
    },
    expected: index >= 461 && index < 525 ? "failed" : "succeeded",
    intentAt: "2026-10-23T00:00:00Z",
    admittedAt: "2026-10-23T00:00:01Z",
    runId: `run-${index}`,
  };
}

test("receipt inventory derives identities and outcomes from all admission records", async () => {
  const base = resolve(".loopy/architecture-tests");
  await mkdir(base, { recursive: true });
  const journal = await mkdtemp(resolve(base, "receipt-inventory-"));

  try {
    const admissions = [...Array.from({ length: 528 }).keys()].map(admission);

    for (const value of admissions) {
      await Bun.write(
        resolve(journal, value.phase, "a", `${value.slug}.json`),
        JSON.stringify(value),
      );
    }

    const runs = admissions.map((value) => ({ id: value.runId, status: value.expected }));
    const inventory = { batch, count: 528, unique: 528, primaryJournal: 525, runs };
    const options = { inventory, batch, journal };
    expect((await receiptInventory(options)).size).toBe(528);
    await expect(
      receiptInventory({ ...options, inventory: { ...inventory, runs: runs.slice(0, 1) } }),
    ).rejects.toThrow();
    await expect(
      receiptInventory({
        ...options,
        inventory: { ...inventory, runs: runs.map((run, index) => (index === 1 ? runs[0] : run)) },
      }),
    ).rejects.toThrow("528 unique");
    await expect(receiptInventory({ ...options, batch: "foreign" })).rejects.toThrow(
      "current-batch",
    );
    const original = admission(0);
    const file = resolve(journal, "primary/a/fixture-0.json");

    for (const changed of [
      { ...original, runId: null },
      { ...original, runId: "run-1" },
      { ...original, admittedAt: null },
      { ...original, expected: "failed" },
      { ...original, input: { ...original.input, batch: "foreign" } },
    ]) {
      await Bun.write(file, JSON.stringify(changed));
      await expect(receiptInventory(options)).rejects.toThrow("mismatched admission");
    }

    await rm(file);
    await expect(receiptInventory(options)).rejects.toThrow("incomplete primary");
    await Bun.write(file, JSON.stringify(original));
    await rm(resolve(journal, "preflight/a/fixture-527.json"));
    await expect(receiptInventory(options)).rejects.toThrow("incomplete preflight");
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});
