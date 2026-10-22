import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { DaemonRunRecord } from "./report-schema.ts";

export function sha(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function requireEqual(actual: string | number, expected: string | number, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, observed ${actual}.`);
  }
}

async function text(record: DaemonRunRecord, path: string) {
  return Bun.file(join(record.outputDirectory, "loopies-playground", path)).text();
}

async function artifact(record: DaemonRunRecord) {
  const value: unknown = JSON.parse(await text(record, "results/result.json"));

  const identity = z
    .object({ batch: z.string(), ordinal: z.number(), slug: z.string() })
    .parse(value);

  requireEqual(identity.batch, record.input.batch, "artifact batch");
  requireEqual(identity.ordinal, record.input.ordinal, "artifact ordinal");
  requireEqual(identity.slug, record.slug, "artifact slug");

  return value;
}

async function lint(record: DaemonRunRecord) {
  const mapped = record.nodeRuns.filter((node) => node.key.nodeId.endsWith(":lint-source"));
  requireEqual(mapped.length, record.input.items.length, "map item count");

  if (record.input.fail) {
    return;
  }

  let findings = 0;

  for (const [index] of record.input.items.entries()) {
    const source = await text(record, index % 2 === 0 ? "src/math.ts" : "src/status.ts");
    findings += source.split("\n").filter((line) => line.trimEnd() !== line).length;
  }

  const expected = `# Lint report\n\nCompleted ${record.input.items.length} source checks.\nFound ${findings} trailing whitespace findings.\n\nThe fixture treats whitespace as advisory.\n`;
  requireEqual(await text(record, "reports/lint.md"), expected, "lint report");

  const result = z
    .object({ files: z.array(z.object({ path: z.string(), content: z.string() })) })
    .parse(await artifact(record));

  for (const file of result.files) {
    requireEqual(await text(record, file.path), file.content, "published file");
  }
}

async function parallel(record: DaemonRunRecord) {
  const sizes = [];

  for (const [target, multiplier] of [
    ["client", 2],
    ["server", 5],
  ] as const) {
    const size = record.input.items.reduce(
      (sum, item) => sum + Math.abs(item) * multiplier + 16,
      0,
    );

    requireEqual(await text(record, `docs/build-${target}.txt`), `${target}\n${size}\n`, target);
    sizes.push(size);
  }

  if (record.input.fail) {
    return;
  }

  const result = z
    .object({ values: z.array(z.number()), checksum: z.number() })
    .parse(await artifact(record));

  requireEqual(JSON.stringify(result.values), JSON.stringify(sizes), "parallel sizes");
  requireEqual(
    result.checksum,
    sizes.reduce((sum, size) => sum + size, 0),
    "parallel checksum",
  );
}

async function retry(record: DaemonRunRecord) {
  const node = record.nodeRuns.find((item) => item.key.nodeId.endsWith(":retry-update"));
  requireEqual(node?.attempt ?? 0, 2, "retry attempt");
  const expected = record.input.items.map((value) => value + (record.input.fail ? 0 : 1));
  requireEqual(
    await text(record, "src/ci-values.txt"),
    expected.join("\n"),
    "retried repository values",
  );

  if (!record.input.fail) {
    const result = z.object({ values: z.array(z.number()) }).parse(await artifact(record));
    requireEqual(JSON.stringify(result.values), JSON.stringify(expected), "retry artifact values");
  }
}

async function validation(record: DaemonRunRecord) {
  const csv = `id,value\n${record.input.items.map((value, index) => `${index + 1},${value}`).join("\n")}\n`;
  requireEqual(await text(record, "data/records.csv"), csv, "seeded CSV");

  const result = z
    .object({ validatedFiles: z.array(z.string()), sourceHash: z.string(), outcome: z.string() })
    .parse(await artifact(record));

  requireEqual(
    JSON.stringify(result.validatedFiles),
    JSON.stringify(["README.md", "docs/policy.md", "src/limits.ts"]),
    "parallel validated files",
  );
  requireEqual(result.sourceHash, sha(csv), "validation CSV hash");
  requireEqual(result.outcome, record.input.fail ? "failed" : "succeeded", "validation outcome");
  const report = await text(record, "docs/validation.md");

  for (const file of result.validatedFiles) {
    const content = await text(record, file);
    requireEqual(
      Number(
        report.includes(`${file}: ${Buffer.byteLength(content)} bytes, sha256 ${sha(content)}`),
      ),
      1,
      "validation report hash",
    );
  }
}

async function security(record: DaemonRunRecord) {
  if (record.hold?.approved === false) {
    requireEqual(
      Number(
        await Bun.file(
          join(record.outputDirectory, "loopies-playground/docs/security-review.md"),
        ).exists(),
      ),
      0,
      "denied publication",
    );

    return;
  }

  const result = z
    .object({
      approved: z.literal(true),
      findings: z.literal(0),
      policyHash: z.string(),
      sourceHash: z.string(),
      outcome: z.string(),
    })
    .parse(await artifact(record));

  requireEqual(
    result.policyHash,
    sha(await text(record, "docs/policy.md")),
    "security policy hash",
  );
  requireEqual(result.sourceHash, sha(await text(record, "src/limits.ts")), "security source hash");
  requireEqual(result.outcome, record.input.fail ? "failed" : "succeeded", "security outcome");
  const expected = `# Security review\n\nOrdinal ${record.input.ordinal}: approved.\nChecked src/limits.ts and docs/policy.md.\nNo forbidden execution or network calls found.\n`;
  requireEqual(await text(record, "docs/security-review.md"), expected, "security publication");
}

export const validators = new Map([
  ["playground-a-lint-report", lint],
  ["playground-b-parallel-build", parallel],
  ["playground-b-retry-marker", retry],
  ["playground-c-repository-validation", validation],
  ["playground-c-security-review", security],
]);
