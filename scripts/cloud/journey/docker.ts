import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { routes } from "../../../packages/loopy/src/contract";
import { canonicalJson, type ExecutionKey } from "../../../packages/loopy/src/core";
import { filesystemReceipt } from "../filesystem-receipt";
import { assert, equal, type Journey } from "./client";

const stateRoot = resolve(import.meta.dir, "../../../.loopy/cloud/sandbox");

async function receipt(key: ExecutionKey, attempt: number) {
  const id = createHash("sha256")
    .update(canonicalJson({ root: stateRoot, workspace: "fixtures", executionKey: key, attempt }))
    .digest("hex");

  const saved = await Effect.runPromise(filesystemReceipt(stateRoot, id));
  assert(
    saved.workspace === "fixtures" && saved.executionKey.runId === key.runId,
    "docker_receipt_identity_mismatch",
  );

  return saved;
}

const isolationSchema = z.object({
  network: z.string(),
  user: z.string(),
  readOnly: z.boolean(),
  privileged: z.boolean(),
  capDrop: z.array(z.string()),
  security: z.array(z.string()),
  mounts: z.array(z.object({ Type: z.string(), Destination: z.string(), RW: z.boolean() })),
});

async function inspect(container: string) {
  const format =
    '{"network":{{json .HostConfig.NetworkMode}},"user":{{json .Config.User}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"capDrop":{{json .HostConfig.CapDrop}},"security":{{json .HostConfig.SecurityOpt}},"mounts":{{json .Mounts}}}';

  const child = Bun.spawn(
    [
      "docker",
      "--context",
      "colima-loopy-cloud-phase1",
      "container",
      "inspect",
      "--format",
      format,
      container,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  assert(exitCode === 0, "owned_container_inspection_failed", { exitCode });
  const parsed = isolationSchema.safeParse(JSON.parse(stdout));
  assert(parsed.success, "container_inspection_schema_failed");
  equal(parsed.data.network, "none", "container_network_enabled");
  equal(parsed.data.user, "1000:1000", "container_user_not_restricted");
  assert(parsed.data.readOnly && !parsed.data.privileged, "container_root_not_restricted");
  assert(
    parsed.data.capDrop.includes("ALL") && parsed.data.security.includes("no-new-privileges:true"),
    "container_privileges_not_dropped",
  );
  assert(
    parsed.data.mounts.every((mount) => mount.Type === "volume"),
    "container_has_host_bind_mount",
  );
  assert(
    parsed.data.mounts.some((mount) => mount.Destination === "/input" && !mount.RW),
    "container_input_not_readonly",
  );
}

export async function docker(journey: Journey, runId: string) {
  const snapshot = await journey.json(routes.run.response, `/runs/${runId}`);
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
