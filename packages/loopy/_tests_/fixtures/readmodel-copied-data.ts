import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  emptyRunCounts,
  type RunDefinitionCount,
  type RunFilter,
  type RunRecord,
  type Store,
} from "@loopy/core";
import { SqlRunStore } from "@loopy/runtime/store/portable";
import { Effect, Exit, Scope } from "effect";
import { BunSqlDriver } from "../../../runtime/src/store/sqlite/bun-driver";
import type { SqlValue } from "../../../runtime/src/store/sqlite/driver";
import { makeSqliteRunStore } from "../../../runtime/src/store/sqlite/store";

const root = resolve(import.meta.dir, "../../../..");

const parent = join(root, ".loopy/architecture-tests");

mkdirSync(parent, { recursive: true });

const directory = mkdtempSync(join(parent, "copied-data-"));

const evidencePath = join(root, ".notes/cloud/architecture/evidence/copied-data.json");

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const hashFile = (file: string) => sha256(readFileSync(file));

const sources = [
  {
    name: "cloud",
    path: ".loopy/playground/diagnostics/quiesced-postload-20261022T203547958718Z/standalone/diagnostic.sqlite",
    sha256: "0d0ce744814caf442edf3c3fde3e74b129019f7602db4bb393a431cd341697fa",
    total: 528,
    succeeded: 464,
    failed: 64,
  },
  {
    name: "daemon",
    path: ".loopy/playground-daemon/daemon-readonly.sqlite",
    sha256: "5f83e877a93e335e4f5ac5d1586c5dea9db6523bf9de9614dd8c377774297771",
    total: 45,
    succeeded: 39,
    failed: 6,
  },
];

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);

    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}

function fingerprints(file: string) {
  return ["", "-wal", "-shm", "-journal"].map((suffix) => {
    const path = file + suffix;

    if (!existsSync(path)) {
      return { path, exists: false };
    }

    const stat = statSync(path, { bigint: true });

    return {
      path,
      exists: true,
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      sha256: hashFile(path),
    };
  });
}

function snapshot(file: string) {
  assert.equal(dirname(file), directory, "SQLite opens copies only");
  const db = new Database(file, { readonly: true });

  try {
    // The fixture reads SQLite cells, including binary cells, at this storage boundary.
    const read = <Row = Record<string, SqlValue | Uint8Array>>(sql: string) =>
      db.query<Row, []>(sql).all();

    const integrity = read<{ integrity_check: string }>("PRAGMA integrity_check");
    assert.deepEqual(integrity, [{ integrity_check: "ok" }]);
    assert.deepEqual(read("PRAGMA foreign_key_check"), []);

    const schema = read<{ type: string; name: string; sql: string | null }>(
      "SELECT type,name,sql FROM sqlite_schema ORDER BY type,name",
    );

    const tables = schema
      .filter(({ type }) => type === "table")
      .map(({ name }) => {
        const rows = read(`SELECT * FROM "${name.replaceAll('"', '""')}"`);

        const encoded = rows.map((row) => JSON.stringify(row)).sort();

        return { name, rows: rows.length, sha256: sha256(encoded.join("\n")) };
      });

    const runs = read<Pick<RunRecord, "id" | "workspace" | "slug" | "status">>(
      "SELECT id,workspace,slug,status FROM runs ORDER BY id",
    );

    const meta = new Map(
      read<{ key: string; value: string }>("SELECT key,value FROM meta").map(({ key, value }) => [
        key,
        value,
      ]),
    );

    return {
      integrity,
      userVersion: read<{ user_version: number }>("PRAGMA user_version")[0]?.user_version,
      schemaVersion: meta.get("schema_version"),
      epoch: meta.get("epoch"),
      cursor: read<{ cursor: number }>("SELECT COALESCE(MAX(sequence),0) AS cursor FROM events")[0]
        ?.cursor,
      schema,
      tables,
      runs,
    };
  } finally {
    db.close();
  }
}

const order = (rows: RunDefinitionCount[]) =>
  [...rows].sort((a, b) =>
    JSON.stringify([a.workspace, a.slug, a.status]).localeCompare(
      JSON.stringify([b.workspace, b.slug, b.status]),
    ),
  );

async function counts(store: Store, baseline: ReturnType<typeof snapshot>) {
  const rows = await Effect.runPromise(store.runCountsByDefinition());
  const keys = rows.map(({ workspace, slug, status }) => JSON.stringify([workspace, slug, status]));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(rows.every(({ count }) => count > 0));

  const identities = new Map(
    baseline.runs.map(({ workspace, slug }) => [
      JSON.stringify([workspace, slug]),
      { workspace, slug },
    ]),
  );

  const slugs = [...new Set(baseline.runs.map(({ slug }) => slug))];
  const workspaces = [...new Set(baseline.runs.map(({ workspace }) => workspace))];

  const filters: RunFilter[] = [
    {},
    ...identities.values(),
    ...slugs.map((slug) => ({ slug })),
    ...workspaces.map((workspace) => ({ workspace })),
  ];

  for (const filter of filters) {
    const expected = emptyRunCounts();
    const actual = emptyRunCounts();

    for (const run of baseline.runs) {
      if (
        (filter.slug === undefined || run.slug === filter.slug) &&
        (filter.workspace === undefined || run.workspace === filter.workspace)
      ) {
        expected[run.status]++;
      }
    }

    for (const row of rows) {
      if (
        (filter.slug === undefined || row.slug === filter.slug) &&
        (filter.workspace === undefined || row.workspace === filter.workspace)
      ) {
        actual[row.status] += row.count;
      }
    }

    assert.deepEqual(actual, expected);
  }

  assert.deepEqual(await Effect.runPromise(store.eventCursor()), {
    epoch: baseline.epoch,
    cursor: baseline.cursor,
  });

  return { rows: order(rows), identities: [...identities.values()], slugs };
}

async function verify(source: (typeof sources)[number]) {
  let original = join(root, source.path);

  if (!existsSync(original) && source.name === "daemon") {
    const matching = files(join(root, ".loopy/playground-daemon")).filter(
      (file) => hashFile(file) === source.sha256,
    );

    assert.equal(matching.length, 1, "Exactly one approved daemon hash match required");
    original = matching[0] ?? original;
  }

  const before = fingerprints(original);
  const adapters = [];

  try {
    assert.equal(hashFile(original), source.sha256, "Source hash mismatch");
    assert.ok(
      !existsSync(`${original}-wal`) || statSync(`${original}-wal`).size === 0,
      "Standalone source has WAL bytes",
    );

    for (const adapter of ["native", "portable"] as const) {
      const file = join(directory, `${source.name}-${adapter}.sqlite`);
      copyFileSync(original, file);
      assert.equal(hashFile(file), source.sha256);
      const baseline = snapshot(file);
      const status = emptyRunCounts();

      for (const run of baseline.runs) {
        status[run.status]++;
      }

      assert.equal(baseline.runs.length, source.total);
      assert.equal(new Set(baseline.runs.map(({ id }) => id)).size, source.total);
      assert.deepEqual(status, {
        ...emptyRunCounts(),
        succeeded: source.succeeded,
        failed: source.failed,
      });
      assert.equal(baseline.schemaVersion, "15");
      let result: Awaited<ReturnType<typeof counts>> | undefined;
      let error: string | null = null;

      const scope = Effect.runSync(Scope.make());

      try {
        const store =
          adapter === "native"
            ? await Effect.runPromise(
                makeSqliteRunStore(file).pipe(Effect.provideService(Scope.Scope, scope)),
              )
            : new SqlRunStore(new BunSqlDriver(file), {
                owner: {
                  identity: { pid: null, host: "copied-data-verification" },
                  isAlive: () => false,
                },
              });

        try {
          result = await counts(store, baseline);
        } finally {
          await Effect.runPromise(store.close());
        }
      } catch (cause) {
        assert.ok(cause instanceof Error);
        error = cause.message;
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }

      const after = snapshot(file);
      assert.deepEqual(after, baseline, "Adapter changed copied data");
      adapters.push({
        adapter,
        required:
          (source.name === "cloud" && adapter === "portable") ||
          (source.name === "daemon" && adapter === "native"),
        unsupportedCrossAdapter: source.name === "cloud" && adapter === "native",
        file,
        copiedSha256: source.sha256,
        baseline,
        afterMatchesBaseline: true,
        status,
        result,
        error,
      });
    }
  } finally {
    assert.deepEqual(fingerprints(original), before, "Original files changed");
  }

  return {
    name: source.name,
    original,
    expectedSha256: source.sha256,
    before,
    after: fingerprints(original),
    sourcePreserved: true,
    adapters,
  };
}

const results = [];

let failure: string | null = null;

try {
  for (const source of sources) {
    results.push(await verify(source));
  }
} catch (cause) {
  assert.ok(cause instanceof Error);
  failure = cause.message;
}

const cases = results.flatMap(({ name, adapters }) =>
  adapters.map(({ adapter, required, unsupportedCrossAdapter, error }) => ({
    name,
    adapter,
    required,
    unsupportedCrossAdapter,
    error,
  })),
);

const unexpectedErrors = cases.filter(
  ({ error, unsupportedCrossAdapter }) => error !== null && !unsupportedCrossAdapter,
);

const passed =
  failure === null &&
  results.length === 2 &&
  unexpectedErrors.length === 0 &&
  cases.filter(({ required }) => required).every(({ error }) => error === null);

const evidence = {
  command: "bun packages/loopy/_tests_/fixtures/readmodel-copied-data.ts",
  baseHead: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim(),
  directory,
  runnerSha256: hashFile(import.meta.path),
  passed,
  failure,
  cases,
  results,
  timingClaim: false,
};

mkdirSync(dirname(evidencePath), { recursive: true });

writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

writeFileSync(join(directory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);

console.log(JSON.stringify({ passed, failure, directory, evidencePath, cases }, null, 2));

process.exitCode = passed ? 0 : 1;
