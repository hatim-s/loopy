import { decodeRouteResponse, encodeRunCursor, routes, routeUrl } from "@loopy/contract";
import { PlaygroundClient } from "../client";
import { evidence, state } from "../config";
import { journalDirectory, readAdmissions } from "../journal";
import {
  artifactPath,
  type PostloadInventory,
  postloadInventory,
  writeArtifact,
} from "./artifacts";
import { countBy } from "./statistics";

const client = await PlaygroundClient.open();

const runs: PostloadInventory["runs"][number][] = [];

const pages: PostloadInventory["pages"][number][] = [];

const startedAt = new Date().toISOString();

let cursor: string | undefined;

for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
  const start = performance.now();

  const response = await client.request(
    routeUrl(routes.runs, { query: { limit: 50, before: cursor } }),
    AbortSignal.timeout(15_000),
  );

  const text = await response.text();
  const bytes = Buffer.byteLength(text);
  const outcome = decodeRouteResponse(routes.runs, response.status, text);

  if (outcome.kind !== "ok") {
    throw new Error(`Post-load inventory request returned HTTP ${response.status}.`);
  }

  const page = outcome.value;
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

const primary = await readAdmissions(journalDirectory(state), "primary");

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

const output = artifactPath(evidence, postloadInventory);

const value: PostloadInventory = {
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
  statuses: countBy(runs, (run) => run.status),
  pages,
  runs,
  limits: [
    "Shared-client end-to-end timing includes API-slot wait and body buffering.",
    "Inventory is bounded to twenty 50-run pages, one sequential request per second; no workflow mutations.",
    "Only IDs,statuses,slug and timestamps are saved; payloads and wait tokens are discarded.",
  ],
};

await writeArtifact(evidence, postloadInventory, value);

process.stdout.write(
  `${JSON.stringify({ output, count: value.count, statuses: value.statuses, missing: missing.length, statusMismatches: statusMismatches.length })}\n`,
);
