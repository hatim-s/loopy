import { sha256Hex } from "./hash";

// Evidence records the source each proof ran against. A pattern that matches nothing means the
// list went stale after a move, so expansion fails instead of hashing fewer files.

export const TRANSPORT_FAILURE_SOURCES = [
  "apps/sandbox/src/**/*.ts",
  "packages/runtime/src/os/spawn.ts",
  "packages/runtime/src/executor/protocol.ts",
  "packages/contract/src/sandbox/*.ts",
  "apps/cloud/dev/transport-failure/*.ts",
] as const;

export const FAILURE_JOURNEY_SOURCES = [
  "apps/cloud/src/scheduler.ts",
  "apps/sandbox/src/attempt/index.ts",
  "apps/sandbox/src/docker/index.ts",
] as const;

// The SQL probe records the store sources whose exported SQL it runs.
export const SQL_PROBE_SOURCES = [
  "packages/runtime/src/store/query/runs.ts",
  "packages/runtime/src/store/query/feeds.ts",
  "packages/runtime/src/store/query/nodes.ts",
  "packages/runtime/src/store/schema/fresh.ts",
  "packages/runtime/src/store/turns.ts",
  "apps/cloud/src/sql-driver.ts",
  "apps/cloud/dev/playground/metrics/sql-queries.ts",
] as const;

/** Sorted repository paths for the patterns. Each pattern must match at least one file. */
export async function sourceFiles(root: string, patterns: readonly string[]) {
  const files = new Set<string>();

  for (const pattern of patterns) {
    const matches = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root }));

    if (matches.length === 0) {
      throw new Error(`Source pattern '${pattern}' matches no file. Update the evidence list.`);
    }

    for (const match of matches) {
      files.add(match);
    }
  }

  return [...files].sort();
}

export async function sourceHashes(root: string, patterns: readonly string[]) {
  const files = await sourceFiles(root, patterns);

  return Object.fromEntries(
    await Promise.all(
      files.map(
        async (path) =>
          [
            path,
            sha256Hex(new Uint8Array(await Bun.file(`${root}/${path}`).arrayBuffer())),
          ] as const,
      ),
    ),
  );
}
