import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCurrentBaseline } from "../../../dev/playground/baseline";
import { arm } from "../../../dev/playground/prepare";
import { playgroundProfile } from "../../../dev/playground/profile";
import { baselineReceipt, expectedEndpoints } from "./baseline-fixture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function freshGate() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopy-baseline-gate-")));
  roots.push(root);
  const profile = playgroundProfile(root, "architecture");

  const context = {
    root,
    state: profile.state,
    evidenceDirectory: profile.evidence,
    profile: profile.name,
    batch: "fresh-batch",
  };

  await mkdir(profile.state, { recursive: true });
  await mkdir(profile.evidence, { recursive: true });
  await writeFile(
    join(profile.state, "source-ready.json"),
    JSON.stringify({
      batch: context.batch,
      revisions: Array.from({ length: 15 }, () => ({})),
    }),
  );

  for (const group of ["a", "b", "c"]) {
    await writeFile(
      join(profile.evidence, `playground-driver-preflight-${group}.json`),
      JSON.stringify({
        status: "passed",
        batch: context.batch,
        completed: 1,
      }),
    );
  }

  return {
    context,
    baseline: join(profile.evidence, "baseline.json"),
    gate: join(profile.state, "load-enabled.json"),
  };
}

test("actual arm rejects null, malformed, non-baseline and all-failed captures without writing its gate", async () => {
  const valid = await baselineReceipt();
  const failed = await baselineReceipt("transport");

  const phaseIssue = {
    path: ["phase"],
    message: 'Invalid option: expected one of "baseline"|"baseline-small"',
  };

  const variants = [
    {
      receipt: { ...valid, samples: [null] },
      expected: {
        issues: [
          { path: ["samples", 0], message: "Invalid input: expected object, received null" },
        ],
      },
    },
    {
      receipt: { ...valid, samples: [{ ...valid.samples[0], bytes: "wrong" }] },
      expected: {
        issues: [
          {
            path: ["samples", 0, "bytes"],
            message: "Invalid input: expected number, received string",
          },
        ],
      },
    },
    { receipt: { ...valid, phase: "during-load" }, expected: { issues: [phaseIssue] } },
    { receipt: { ...valid, phase: "baseline-empty" }, expected: { issues: [phaseIssue] } },
    { receipt: { ...valid, phase: "postload" }, expected: { issues: [phaseIssue] } },
    {
      receipt: failed,
      expected: {
        message: `Baseline lacks successful measurement coverage: ${expectedEndpoints.join(", ")}.`,
      },
    },
    {
      receipt: { ...valid, samples: [] },
      expected: {
        issues: [{ path: ["samples"], message: "Too small: expected array to have >=1 items" }],
      },
    },
    {
      receipt: { ...valid, batch: "foreign-batch" },
      expected: { issues: [{ path: ["batch"], message: 'Invalid input: expected "fresh-batch"' }] },
    },
  ];

  for (const { receipt, expected } of variants) {
    const fixture = await freshGate();
    await writeFile(fixture.baseline, JSON.stringify(receipt));
    await expect(arm(fixture.baseline, fixture.context)).rejects.toMatchObject(expected);
    expect(await Bun.file(fixture.gate).exists()).toBe(false);
    expect(await Bun.file(join(fixture.context.state, "config.json")).exists()).toBe(false);
  }
});

test("actual arm requires successful coverage for every unconditional comparison endpoint", async () => {
  const valid = await baselineReceipt();

  for (const endpoint of expectedEndpoints) {
    const fixture = await freshGate();
    const samples = valid.samples.filter((sample) => sample.endpoint !== endpoint);
    await writeFile(fixture.baseline, JSON.stringify({ ...valid, samples }));
    await expect(arm(fixture.baseline, fixture.context)).rejects.toThrow(
      `Baseline lacks successful measurement coverage: ${endpoint}.`,
    );
    expect(await Bun.file(fixture.gate).exists()).toBe(false);
  }
});

test("actual arm opens only for a usable same-batch baseline and three successful preflights", async () => {
  const fixture = await freshGate();
  const valid = await baselineReceipt();
  const failed = await baselineReceipt("transport");
  const receipt = { ...valid, samples: [...valid.samples, ...failed.samples] };
  await writeFile(fixture.baseline, JSON.stringify(receipt));
  await arm(fixture.baseline, fixture.context);
  expect(await Bun.file(fixture.gate).json()).toMatchObject({
    batch: fixture.context.batch,
    baseline: fixture.baseline,
  });
  expect(
    (
      await requireCurrentBaseline(
        fixture.baseline,
        fixture.context.batch,
        fixture.context.evidenceDirectory,
      )
    ).samples,
  ).toHaveLength(28);
  expect(await Bun.file(fixture.baseline).json()).toEqual(receipt);
  const alias = await freshGate();
  await writeFile(alias.baseline, JSON.stringify({ ...valid, phase: "baseline" }));
  await arm(alias.baseline, alias.context);
  expect(await Bun.file(alias.gate).exists()).toBe(true);
  const missing = await freshGate();
  await writeFile(missing.baseline, JSON.stringify(valid));
  await rm(join(missing.context.evidenceDirectory, "playground-driver-preflight-c.json"));
  await expect(arm(missing.baseline, missing.context)).rejects.toThrow();
  expect(await Bun.file(missing.gate).exists()).toBe(false);
});

test("actual arm rejects baseline evidence outside its canonical profile directory", async () => {
  const fixture = await freshGate();
  const path = join(fixture.context.root, "old-baseline.json");
  await writeFile(path, JSON.stringify(await baselineReceipt()));
  await expect(arm(path, fixture.context)).rejects.toThrow("selected evidence directory");
  expect(await Bun.file(fixture.gate).exists()).toBe(false);
});

test("actual arm does not count unsuccessful or incomplete observations as endpoint coverage", async () => {
  const valid = await baselineReceipt();
  const endpoint = "runs.latest";

  const incomplete = [
    { status: 500 },
    { bytes: 0 },
    { headersMs: null },
    { parseMs: null },
    { totalMs: -1 },
    { failure: "http" },
  ];

  for (const change of incomplete) {
    const fixture = await freshGate();

    const samples = valid.samples.map((sample) =>
      sample.endpoint === endpoint ? { ...sample, ...change } : sample,
    );

    await writeFile(fixture.baseline, JSON.stringify({ ...valid, samples }));
    await expect(arm(fixture.baseline, fixture.context)).rejects.toThrow(
      `Baseline lacks successful measurement coverage: ${endpoint}.`,
    );
    expect(await Bun.file(fixture.gate).exists()).toBe(false);
  }
});
