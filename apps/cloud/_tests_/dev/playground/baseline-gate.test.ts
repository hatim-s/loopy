import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { qualityTestRoot } from "../../../../../packages/loopy/_tests_/fixtures/quality-test-root";
import { requireCurrentBaseline } from "../../../dev/playground/baseline";
import { groups, summaryPath } from "../../../dev/playground/journal";
import { baselineEndpoints } from "../../../dev/playground/metrics/sampler";
import type { Sample } from "../../../dev/playground/metrics/statistics";
import { arm } from "../../../dev/playground/prepare";
import { playgroundProfile } from "../../../dev/playground/profile";
import { baselineReceipt } from "./baseline-fixture";

const batch = "fresh-batch";

async function freshProfile() {
  const root = qualityTestRoot("baseline-gate");
  const profile = playgroundProfile(root, "architecture");
  await mkdir(profile.state, { recursive: true });
  await mkdir(profile.evidence, { recursive: true });

  return { profile, baseline: join(profile.evidence, "baseline.json") };
}

test("the baseline gate accepts only a same-batch capture with every endpoint measured", async () => {
  const valid = await baselineReceipt();
  const failed = await baselineReceipt("transport");

  const runsLatest = (change: Partial<Sample>) => ({
    ...valid,
    samples: valid.samples.map((sample) =>
      sample.endpoint === "runs.latest" ? { ...sample, ...change } : sample,
    ),
  });

  const rejected = [
    { ...valid, samples: [null] },
    { ...valid, phase: "during-load" },
    { ...valid, phase: "postload" },
    { ...valid, samples: [] },
    { ...valid, batch: "foreign-batch" },
    { ...valid, workloadControls: { apiSlots: 5, runtimeAttempts: 4 } },
    failed,
    ...baselineEndpoints.map((endpoint) => ({
      ...valid,
      samples: valid.samples.filter((sample) => sample.endpoint !== endpoint),
    })),
    ...[{ status: 500 }, { bytes: 0 }, { headersMs: null }, { parseMs: null }, { totalMs: -1 }].map(
      runsLatest,
    ),
  ];

  for (const receipt of rejected) {
    const { profile, baseline } = await freshProfile();
    await writeFile(baseline, JSON.stringify(receipt));
    await expect(requireCurrentBaseline(baseline, batch, profile.evidence)).rejects.toThrow();
  }

  const { profile, baseline } = await freshProfile();
  const mixed = { ...valid, samples: [...valid.samples, ...failed.samples] };
  await writeFile(baseline, JSON.stringify(mixed));
  expect((await requireCurrentBaseline(baseline, batch, profile.evidence)).samples).toHaveLength(
    mixed.samples.length,
  );
  const outside = join(profile.root, "old-baseline.json");
  await writeFile(outside, JSON.stringify(valid));
  await expect(requireCurrentBaseline(outside, batch, profile.evidence)).rejects.toThrow(
    "selected evidence directory",
  );
});

test("arm writes the load gate only after a usable baseline and three passed preflights", async () => {
  const { profile, baseline } = await freshProfile();
  const gate = join(profile.state, "load-enabled.json");
  await writeFile(
    join(profile.state, "source-ready.json"),
    JSON.stringify({
      batch,
      at: new Date().toISOString(),
      repository: profile.repository,
      commit: "seed",
      files: 19,
      sourceHash: "f".repeat(64),
      revisions: [...Array(15).keys()].map((index) => ({
        group: groups[index % 3],
        slug: `fixture-${index}`,
        revision: "r".repeat(64),
        file: `fixture-${index}.ts`,
      })),
    }),
  );
  await writeFile(baseline, JSON.stringify(await baselineReceipt("transport")));

  for (const group of groups) {
    await writeFile(
      summaryPath(profile.evidence, "preflight", group),
      JSON.stringify({
        status: "passed",
        scope: "local-wrangler-docker",
        batch,
        group,
        phase: "preflight",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        planned: 1,
        completed: 1,
        results: [],
      }),
    );
  }

  await expect(arm({ profile, baseline, batch })).rejects.toThrow("measurement coverage");
  expect(await Bun.file(gate).exists()).toBe(false);
  await writeFile(baseline, JSON.stringify(await baselineReceipt()));
  await rm(summaryPath(profile.evidence, "preflight", "c"));
  await expect(arm({ profile, baseline, batch })).rejects.toThrow();
  expect(await Bun.file(gate).exists()).toBe(false);
  await writeFile(
    summaryPath(profile.evidence, "preflight", "c"),
    await Bun.file(summaryPath(profile.evidence, "preflight", "a"))
      .text()
      .then((text) => text.replace('"group":"a"', '"group":"c"')),
  );
  await arm({ profile, baseline, batch });
  expect(await Bun.file(gate).json()).toMatchObject({ batch, baseline });
});
