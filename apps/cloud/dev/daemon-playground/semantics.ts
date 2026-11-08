import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { nodeRunSchema } from "@loopy/contract";
import { Schema } from "effect";
import { artifactIdentitySchema } from "../playground/repository";
import { sha256Hex } from "../shared/hash";
import type { DaemonRunRecord } from "./report-schema";

type VerifiedRecord = DaemonRunRecord & { nodeRuns: readonly (typeof nodeRunSchema.Type)[] };

export function requireEqual<T>(actual: T, expected: T, label: string) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}.`,
    );
  }
}

async function text(record: VerifiedRecord, path: string) {
  return Bun.file(join(record.outputDirectory, "loopies-playground", path)).text();
}

async function artifact<S extends Schema.ConstraintDecoder<unknown>>(
  record: VerifiedRecord,
  schema: S,
) {
  const value: unknown = JSON.parse(await text(record, "results/result.json"));
  const identity = Schema.decodeUnknownSync(artifactIdentitySchema)(value);

  requireEqual(identity.batch, record.input.batch, "artifact batch");
  requireEqual(identity.ordinal, record.input.ordinal, "artifact ordinal");
  requireEqual(identity.slug, record.slug, "artifact slug");

  return Schema.decodeUnknownSync(schema)(value);
}

async function lint(record: VerifiedRecord) {
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

  const result = await artifact(
    record,
    Schema.Struct({
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  );

  for (const file of result.files) {
    requireEqual(await text(record, file.path), file.content, "published file");
  }
}

async function parallel(record: VerifiedRecord) {
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

  const result = await artifact(
    record,
    Schema.Struct({ values: Schema.Array(Schema.Number), checksum: Schema.Number }),
  );

  requireEqual(result.values, sizes, "parallel sizes");
  requireEqual(
    result.checksum,
    sizes.reduce((sum, size) => sum + size, 0),
    "parallel checksum",
  );
}

async function retry(record: VerifiedRecord) {
  const node = record.nodeRuns.find((item) => item.key.nodeId.endsWith(":retry-update"));
  requireEqual(node?.attempt, 2, "retry attempt");
  const expected = record.input.items.map((value) => value + (record.input.fail ? 0 : 1));
  requireEqual(
    await text(record, "src/ci-values.txt"),
    expected.join("\n"),
    "retried repository values",
  );

  if (!record.input.fail) {
    const result = await artifact(record, Schema.Struct({ values: Schema.Array(Schema.Number) }));
    requireEqual(result.values, expected, "retry artifact values");
  }
}

async function validation(record: VerifiedRecord) {
  const csv = `id,value\n${record.input.items.map((value, index) => `${index + 1},${value}`).join("\n")}\n`;
  requireEqual(await text(record, "data/records.csv"), csv, "seeded CSV");

  const result = await artifact(
    record,
    Schema.Struct({
      validatedFiles: Schema.Array(Schema.String),
      sourceHash: Schema.String,
      outcome: Schema.String,
    }),
  );

  requireEqual(
    result.validatedFiles,
    ["README.md", "docs/policy.md", "src/limits.ts"],
    "parallel validated files",
  );
  requireEqual(result.sourceHash, sha256Hex(csv), "validation CSV hash");
  requireEqual(result.outcome, record.input.fail ? "failed" : "succeeded", "validation outcome");
  const report = await text(record, "docs/validation.md");

  for (const file of result.validatedFiles) {
    const content = await text(record, file);
    requireEqual(
      report.includes(`${file}: ${Buffer.byteLength(content)} bytes, sha256 ${sha256Hex(content)}`),
      true,
      "validation report hash",
    );
  }
}

async function security(record: VerifiedRecord) {
  if (record.hold?.approved === false) {
    requireEqual(
      await Bun.file(
        join(record.outputDirectory, "loopies-playground/docs/security-review.md"),
      ).exists(),
      false,
      "denied publication",
    );

    return;
  }

  const result = await artifact(
    record,
    Schema.Struct({
      approved: Schema.Literal(true),
      findings: Schema.Literal(0),
      policyHash: Schema.String,
      sourceHash: Schema.String,
      outcome: Schema.String,
    }),
  );

  requireEqual(
    result.policyHash,
    sha256Hex(await text(record, "docs/policy.md")),
    "security policy hash",
  );
  requireEqual(
    result.sourceHash,
    sha256Hex(await text(record, "src/limits.ts")),
    "security source hash",
  );
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
