import { resolve } from "node:path";
import { encodeBoundary, routes } from "@loopy/contract";
import { cloudRoutes } from "@loopy/contract/sandbox";
import { Effect } from "effect";
import { assert, equal } from "../shared/assert";
import { compileFixture } from "../shared/compile-fixture";
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

const query = encodeBoundary(cloudRoutes.artifact.query)({
  executionKey: node.key,
  attempt: node.attempt,
  path: "firstfail",
});

const artifact = await journey.call(cloudRoutes.artifact, { query });

const bytes = Buffer.from(artifact.bytes, "base64");

equal(bytes.toString(), "firstfail", "artifact_content_mismatch");

equal(artifact.size, bytes.length, "artifact_size_mismatch");

equal(artifact.sha256, sha256Hex(bytes), "artifact_hash_mismatch");

const read = (input: Partial<typeof query>, principal?: "none" | "other") =>
  journey.send(cloudRoutes.artifact, { query: { ...query, ...input } }, { principal });

await journey.denied(read({}, "none"), 401, "unauthorized");

await journey.denied(read({}, "other"), 404, "not_found");

await journey.denied(read({ path: "../escape" }), 400, "bad_request");

await journey.denied(read({ path: "missing" }), 404, "not_found");

await journey.denied(read({ attempt: 999 }), 404, "not_found");

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
