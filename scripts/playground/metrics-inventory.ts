import { resolve } from "node:path";
import { encodeRunCursor, type RunView, routes } from "../../packages/loopy/src/contract/index.js";
import { PlaygroundClient } from "./client.js";
import { atomic, root, state } from "./config.js";
import { admissionSchema } from "./journal.js";

const client = await PlaygroundClient.open();

const runs: Pick<RunView, "id" | "slug" | "status" | "createdAt" | "updatedAt">[] = [];

const pages = [];

const startedAt = new Date().toISOString();

let cursor: string | undefined;

for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
  const query = new URLSearchParams({ limit: "50" });

  if (cursor) {
    query.set("before", cursor);
  }

  const start = performance.now();
  const response = await client.request(`/runs?${query}`, AbortSignal.timeout(15_000));
  const text = await response.text();
  const bytes = Buffer.byteLength(text);

  if (!response.ok || bytes > 8 * 1024 * 1024) {
    throw new Error("Post-load inventory request failed or exceeded8MiB.");
  }

  const page = routes.runs.response.parse(JSON.parse(text));
  pages.push({
    pageIndex,
    at: new Date().toISOString(),
    items: page.length,
    bytes,
    status: response.status,
    clientEndToEndMs: performance.now() - start,
  });
  runs.push(
    ...page.map((run) => ({
      id: run.id,
      slug: run.slug,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    })),
  );

  if (page.length < 50) {
    break;
  }

  const last = page.at(-1);

  if (!last) {
    throw new Error("Inventory page unexpectedly empty.");
  }

  cursor = encodeRunCursor(last);
  await Bun.sleep(Math.max(0, 1000 - (performance.now() - start)));
}

const primary = [];

for await (const path of new Bun.Glob("primary/*/*.json").scan({
  cwd: resolve(state, "journal"),
  absolute: true,
})) {
  if (!path.endsWith(".progress.json")) {
    primary.push(admissionSchema.parse(await Bun.file(path).json()));
  }
}

const identities = new Set(runs.map((run) => run.id));

const missing = primary.flatMap((admission) =>
  admission.runId === null || !identities.has(admission.runId) ? [admission.runId] : [],
);

const statusMismatches = primary.flatMap((admission) => {
  const run = runs.find((item) => item.id === admission.runId);

  return run && run.status !== admission.expected
    ? [{ id: run.id, expected: admission.expected, actual: run.status }]
    : [];
});

const output = resolve(
  root,
  ".notes/cloud/evidence/playground-performance-postload-inventory.json",
);

const value = {
  scope: "post-load-paginated-api-identity-inventory",
  startedAt,
  endedAt: new Date().toISOString(),
  api: client.settings.api,
  workspace: client.settings.workspace,
  batch: client.settings.batch,
  count: runs.length,
  unique: identities.size,
  primaryJournal: primary.length,
  missing,
  statusMismatches,
  statuses: Object.fromEntries(
    [...new Set(runs.map((run) => run.status))].map((status) => [
      status,
      runs.filter((run) => run.status === status).length,
    ]),
  ),
  pages,
  runs,
  limits: [
    "Shared-client end-to-end timing includes API-slot wait and body buffering.",
    "Inventory is bounded to twenty50-run pages,one sequential request persecond; no workflow mutations. Page200failedHTTP500 and is preserved in separate pagination-boundary evidence.",
    "Only IDs,statuses,slug and timestamps are saved; payloads and wait tokens are discarded.",
  ],
};

await atomic(output, value);

process.stdout.write(
  `${JSON.stringify({ output, count: value.count, statuses: value.statuses, missing: missing.length, statusMismatches: statusMismatches.length })}\n`,
);
