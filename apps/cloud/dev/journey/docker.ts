import { resolve } from "node:path";
import { routes } from "@loopy/contract";
import { attemptId } from "@loopy/contract/sandbox";
import type { ExecutionKey } from "@loopy/core";
import { Effect, Schema } from "effect";
import { filesystemReceipt } from "../filesystem-receipt";
import { assert, equal } from "../shared/assert";
import { docker as runDocker } from "../shared/process";
import { localState } from "../stack/credentials";
import type { Journey } from "./client";

const stateRoot = resolve(localState, "sandbox");

async function receipt(key: ExecutionKey, attempt: number) {
  const id = await attemptId(stateRoot, { workspace: "fixtures", executionKey: key, attempt });

  const saved = await Effect.runPromise(filesystemReceipt(stateRoot, id));
  assert(
    saved.workspace === "fixtures" && saved.executionKey.runId === key.runId,
    "docker_receipt_identity_mismatch",
  );

  return saved;
}

const isolationSchema = Schema.Struct({
  network: Schema.String,
  user: Schema.String,
  readOnly: Schema.Boolean,
  privileged: Schema.Boolean,
  capDrop: Schema.Array(Schema.String),
  security: Schema.Array(Schema.String),
  mounts: Schema.Array(
    Schema.Struct({ Type: Schema.String, Destination: Schema.String, RW: Schema.Boolean }),
  ),
});

const decodeIsolation = Schema.decodeUnknownOption(isolationSchema);

async function inspect(container: string) {
  const format =
    '{"network":{{json .HostConfig.NetworkMode}},"user":{{json .Config.User}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"capDrop":{{json .HostConfig.CapDrop}},"security":{{json .HostConfig.SecurityOpt}},"mounts":{{json .Mounts}}}';

  const stdout = await runDocker(["container", "inspect", "--format", format, container], {
    env: process.env,
  });

  const parsed = decodeIsolation(JSON.parse(stdout));
  assert(parsed._tag === "Some", "container_inspection_schema_failed");
  const isolation = parsed.value;
  equal(isolation.network, "none", "container_network_enabled");
  equal(isolation.user, "1000:1000", "container_user_not_restricted");
  assert(isolation.readOnly && !isolation.privileged, "container_root_not_restricted");
  assert(
    isolation.capDrop.includes("ALL") && isolation.security.includes("no-new-privileges:true"),
    "container_privileges_not_dropped",
  );
  assert(
    isolation.mounts.every((mount) => mount.Type === "volume"),
    "container_has_host_bind_mount",
  );
  assert(
    isolation.mounts.some((mount) => mount.Destination === "/input" && !mount.RW),
    "container_input_not_readonly",
  );
}

export async function docker(journey: Journey, runId: string) {
  const snapshot = await journey.call(routes.run, { params: { id: runId } });
  const receipts: Awaited<ReturnType<typeof receipt>>[] = [];

  for (const label of ["greeting", "descriptor", "firstfail"]) {
    const node = snapshot.nodeRuns.find((value) => value.key.nodeId.endsWith(`:${label}`));
    assert(node, "expected_docker_execution_missing", { label });
    const saved = await receipt(node.key, node.attempt);
    assert(
      saved.kind === "finished" && saved.result.kind === "succeeded",
      "docker_completion_receipt_missing",
      { label },
    );
    await inspect(saved.container);
    receipts.push(saved);

    if (label === "firstfail") {
      const first = await receipt(node.key, 1);
      assert(
        first.kind === "finished" &&
          first.result.kind === "failed" &&
          first.result.error.code === "exit" &&
          first.result.exitCode === 7,
        "docker_firstfail_receipt_missing",
      );
      await inspect(first.container);
      equal(first.volume, saved.volume, "retry_workspace_not_retained");
      receipts.push(first);
    }
  }

  equal(
    new Set(receipts.map((saved) => saved.volume)).size,
    1,
    "run_workspace_not_shared_between_nodes",
  );

  return {
    runId,
    containersInspected: receipts.length,
    network: "none",
    user: "1000:1000",
    rootReadOnly: true,
    inputReadOnly: true,
    hostBindMounts: 0,
    retryFirstExitCode: 7,
  };
}
