import { resolve } from "node:path";
import {
  decodeBoundary,
  executionSpecSchema,
  type RunSnapshotView,
  receiptSchema,
  routes,
} from "@loopy/contract";
import {
  type SandboxAttemptIdentity,
  type SandboxAttemptRequest,
  sandboxArtifactQuerySchema,
  sandboxArtifactSchema,
  searchParams,
} from "@loopy/contract/sandbox";
import { SANDBOX_DOCKER_CONTEXT, SANDBOX_IMAGE } from "../../../sandbox/src/docker/identity";
import type { StoredReceipt } from "../filesystem-receipt";
import { ApiClient } from "../shared/api-client";
import { assert, JourneyFailure } from "../shared/assert";
import { EvidenceLog } from "../shared/evidence-log";
import { until } from "../shared/poll";
import { root } from "../stack/constants";
import { api, sandbox, state } from "./config";
import { docker, owned } from "./resources";
import { FailureStack } from "./stack";

export class FailureJourney {
  readonly stack = new FailureStack();
  readonly api = new ApiClient({ origin: api, token: this.stack.token, timeoutMs: 10_000 });
  private readonly provider = new ApiClient({
    origin: sandbox,
    token: this.stack.sandboxToken,
    timeoutMs: 10_000,
  });
  readonly evidence = new EvidenceLog(resolve(root, ".notes/cloud/evidence/failures.json"), {
    scope: "actual-local-wrangler-and-docker-only",
    command: "bun --no-env-file apps/cloud/dev/failures/index.ts",
    api,
    sandbox,
    stateRoot: state,
    dockerContext: SANDBOX_DOCKER_CONTEXT,
    image: SANDBOX_IMAGE,
    gaps: [
      "No remote deployment or provider tested.",
      "No Docker CLI transport fault injected in the real Docker journey.",
      "No completion push endpoint exists. Late completion is exercised by recovery of the durable finished provider receipt.",
    ],
  });

  async start(slug: string) {
    const run = await this.api.call(routes.startRun, {
      params: { slug },
      body: { input: {}, workspace: "fixtures" },
    });

    this.evidence.runs.push(run.id);

    return run;
  }

  snapshot(id: string) {
    return this.api.call(routes.run, { params: { id } });
  }

  until<T>(
    read: () => Promise<T>,
    accept: (value: T) => boolean,
    failure: string,
    timeoutMs = 50_000,
  ) {
    return until(read, accept, {
      timeoutMs,
      intervalMs: 250,
      timeout: () => new JourneyFailure({ failure }),
    });
  }

  wait(id: string) {
    return this.api.waitForRun(id, { timeoutMs: 50_000, intervalMs: 250 });
  }

  async running(id: string, effect = "started\n") {
    const isStarted = (value: StoredReceipt) =>
      value.executionKey.runId === id && value.kind === "started";

    const saved = await this.until(
      () => owned.receipts(),
      (values) => values.some(isStarted),
      "started_receipt_missing",
    );

    const receipt = saved.find(isStarted);
    assert(receipt, "started_receipt_missing");
    await this.until(
      async () =>
        (
          await docker(["ps", "--filter", `name=^/${receipt.container}$`, "--format", "{{.Names}}"])
        ).trim(),
      (value) => value === receipt.container,
      "worker_not_running",
    );
    await owned.container(receipt);
    await this.until(
      () =>
        docker([
          "exec",
          "--user",
          "1000:1000",
          receipt.container,
          "/bin/sh",
          "-c",
          "test -f /workspace/effects && cat /workspace/effects || true",
        ]),
      (value) => value === effect,
      "effect_not_observed",
    );

    const spec = decodeBoundary(executionSpecSchema)(
      JSON.parse(
        await docker([
          "exec",
          "--user",
          "1000:1000",
          receipt.container,
          "cat",
          "/input/request.json",
        ]),
      ),
    );

    assert(spec.kind === "command" && spec.parse === null, "fixture_not_plain_command");

    return {
      receipt,
      request: {
        workspace: "fixtures",
        executionKey: receipt.executionKey,
        attempt: receipt.attempt,
        spec,
        bundles: [],
      } satisfies SandboxAttemptRequest,
    };
  }

  async artifact(receipt: SandboxAttemptIdentity) {
    const query = searchParams(sandboxArtifactQuerySchema, { ...receipt, path: "effects" });

    const result = await this.provider.json(sandboxArtifactSchema, `/artifacts?${query}`);

    return Buffer.from(result.bytes, "base64").toString("utf8");
  }

  async assertSingleAttempt(snapshot: RunSnapshotView) {
    const own = (await owned.receipts()).filter(
      (receipt) => receipt.executionKey.runId === snapshot.run.id,
    );

    assert(
      own.length === 1 && own[0]?.attempt === 1 && own[0].kind === "finished",
      "execution_repeated",
      { receiptCount: own.length },
    );
    const node = snapshot.nodeRuns.find((value) => value.key.nodeId.endsWith(":effect"));
    assert(node?.attempt === 1, "node_retried_unknown_effect");

    return own[0];
  }

  async duplicate(request: SandboxAttemptRequest, kind: "started" | "finished") {
    const admit = () => this.provider.json(receiptSchema, "/attempts", { body: request });
    const responses = await Promise.all([admit(), admit()]);

    assert(
      responses.every((response) => response.kind === kind),
      "duplicate_admission_changed_receipt",
    );
  }
}
