import { resolve } from "node:path";
import { routes, sandboxArtifactSchema } from "@loopy/contract";
import { Effect } from "effect";
import { assert, equal } from "../shared/assert";
import { compileFixture } from "../shared/fixture-client";
import { sha256Hex } from "../shared/hash";
import { root } from "../stack/constants";
import { Journey } from "./client";

const journey = await Journey.open();

await journey.upload(await Effect.runPromise(compileFixture("execution.ts")));

const run = await journey.start("cloud-journey-execution", {
  name: "fixture",
  chooseYes: true,
  items: [2],
});

const snapshot = await journey.wait(run.id);

assert(snapshot.run.status === "succeeded", "artifact_fixture_failed");

const node = snapshot.nodeRuns.find((value) => value.key.nodeId.endsWith(":firstfail"));

assert(node, "artifact_attempt_missing");

const query = new URLSearchParams({
  key: JSON.stringify(node.key),
  attempt: String(node.attempt),
  path: "firstfail",
});

// The artifact route belongs to the cloud worker, not the daemon route table.
const path = `/api/cloud/artifacts?${query}`;

const artifact = await journey.json(sandboxArtifactSchema, path);

const bytes = Buffer.from(artifact.bytes, "base64");

equal(bytes.toString(), "firstfail", "artifact_content_mismatch");

equal(artifact.size, bytes.length, "artifact_size_mismatch");

equal(artifact.sha256, sha256Hex(bytes), "artifact_hash_mismatch");

await journey.denied(journey.request(path, { principal: "none" }), 401, "unauthorized");

await journey.denied(journey.request(path, { principal: "other" }), 404, "not_found");

query.set("path", "../escape");

await journey.denied(journey.request(`/api/cloud/artifacts?${query}`), 400, "bad_request");

query.set("path", "missing");

await journey.denied(journey.request(`/api/cloud/artifacts?${query}`), 404, "not_found");

query.set("path", "firstfail");

query.set("attempt", "999");

await journey.denied(journey.request(`/api/cloud/artifacts?${query}`), 404, "not_found");

const current = await journey.call(routes.run, { params: { id: run.id } });

equal(current.run.status, "succeeded", "artifact_read_changed_run");

const evidence = {
  status: "passed",
  at: new Date().toISOString(),
  runId: run.id,
  command: "bun --no-env-file apps/cloud/dev/journey/artifact.ts",
  assertions: [
    "content",
    "size",
    "sha256",
    "authentication",
    "workspace isolation",
    "traversal",
    "missing file",
    "missing attempt",
    "run unchanged",
  ],
  scope: "terminal run workspace file, not an immutable per-attempt snapshot",
};

await Bun.write(
  resolve(root, ".notes/cloud/evidence/artifacts.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);

console.log(JSON.stringify(evidence));
