import { createHash } from "node:crypto";
import { routes, sandboxArtifactSchema } from "../../packages/loopy/src/contract/index.js";
import { assert, equal, Journey } from "./journey-client.js";

const journey = await Journey.open();

await journey.upload(await journey.compiled("execution.ts"));

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

const path = `/cloud/artifacts?${query}`;

const artifact = await journey.json(sandboxArtifactSchema, path);

const bytes = Buffer.from(artifact.bytes, "base64");

equal(bytes.toString(), "firstfail", "artifact_content_mismatch");

equal(artifact.size, bytes.length, "artifact_size_mismatch");

equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"), "artifact_hash_mismatch");

await journey.denied(path, 401, "unauthorized", { principal: "none" });

await journey.denied(path, 404, "not_found", { principal: "other" });

query.set("path", "../escape");

await journey.denied(`/cloud/artifacts?${query}`, 400, "bad_request");

query.set("path", "missing");

await journey.denied(`/cloud/artifacts?${query}`, 404, "not_found");

query.set("path", "firstfail");

query.set("attempt", "999");

await journey.denied(`/cloud/artifacts?${query}`, 404, "not_found");

const current = await journey.json(routes.run.response, `/runs/${run.id}`);

equal(current.run.status, "succeeded", "artifact_read_changed_run");

const evidence = {
  status: "passed",
  at: new Date().toISOString(),
  runId: run.id,
  command: "bun --no-env-file scripts/cloud/artifact-journey.ts",
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

await Bun.write(".notes/cloud/evidence/artifacts.json", `${JSON.stringify(evidence, null, 2)}\n`);

console.log(JSON.stringify(evidence));
