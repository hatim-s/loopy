import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { z } from "zod";
import type { storedReceiptSchema } from "../../apps/sandbox/src/receipts.js";
import { compile } from "../../packages/loopy/src/compiler/index.js";
import {
  type Json,
  putLoopyBodySchema,
  type RunSnapshotView,
  routes,
  type SandboxAttemptRequest,
  sandboxArtifactSchema,
  sandboxExecutionSpecSchema,
  sandboxReceiptSchema,
} from "../../packages/loopy/src/contract/index.js";
import { api, root, sandbox, state } from "./failures-config.js";
import { docker, ownedContainer, receipts } from "./failures-resources.js";
import { FailureStack } from "./failures-stack.js";
import { assert, JourneyFailure } from "./journey-client.js";

type Evidence = Record<string, Json>;

type Result = { name: string; status: "passed" | "failed"; durationMs: number; evidence: Evidence };

export class FailureJourney {
  readonly stack = new FailureStack();
  readonly results: Result[] = [];
  readonly runs: string[] = [];
  readonly startedAt = new Date().toISOString();

  async json<T>(
    schema: z.ZodType<T>,
    path: string,
    body?: Json | z.infer<typeof putLoopyBodySchema>,
    method = "POST",
  ): Promise<T> {
    const response = await fetch(`${api}/api${path}`, {
      method: body === undefined ? "GET" : method,
      headers: { Authorization: `Bearer ${this.stack.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    assert(response.ok, "failure_journey_http_error", { path, httpStatus: response.status });

    return schema.parse(await response.json());
  }

  async provider<T>(schema: z.ZodType<T>, path: string, body?: SandboxAttemptRequest) {
    const response = await fetch(`${sandbox}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.stack.sandboxToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    assert(response.ok, "provider_http_error", { httpStatus: response.status });

    return schema.parse(await response.json());
  }

  async upload(name: string) {
    const path = resolve(root, "packages/loopy/_tests_/fixtures/cloud", name);
    const compiled = await compile(path);
    assert(compiled.ok, "failure_fixture_compile_failed", {
      fixture: name,
      diagnostics: compiled.ok
        ? []
        : compiled.diagnostics.map((value) => `${value.code}:${value.line}:${value.column}`),
    });

    const body = putLoopyBodySchema.parse({
      graph: compiled.graph,
      revision: compiled.revision,
      sourceArtifact: compiled.sourceArtifact,
      bundles: compiled.bundles.map((bundle) => ({
        ...bundle,
        bytes: Buffer.from(bundle.bytes).toString("base64"),
      })),
      source: { path, workspace: "fixtures" },
      replace: true,
    });

    await this.json(routes.putLoopy.response, `/loopies/${body.graph.name}`, body, "PUT");
  }

  async start(slug: string) {
    const run = await this.json(routes.startRun.response, `/loopies/${slug}/runs`, {
      input: {},
      workspace: "fixtures",
    });

    this.runs.push(run.id);

    return run;
  }

  snapshot(id: string) {
    return this.json(routes.run.response, `/runs/${id}`);
  }

  async until<T>(
    read: () => Promise<T>,
    accept: (value: T) => boolean,
    failure: string,
    timeoutMs = 50_000,
  ) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const value = await read();

      if (accept(value)) {
        return value;
      }

      await Bun.sleep(250);
    }

    throw new JourneyFailure({ failure });
  }

  wait(id: string) {
    return this.until(
      () => this.snapshot(id),
      (snapshot) => ["succeeded", "failed", "cancelled"].includes(snapshot.run.status),
      "failure_run_did_not_finish",
    );
  }

  async running(id: string, effect = "started\n") {
    const saved = await this.until(
      () => receipts(),
      (values) =>
        values.some((value) => value.executionKey.runId === id && value.kind === "started"),
      "started_receipt_missing",
    );

    const receipt = saved.find(
      (value) => value.executionKey.runId === id && value.kind === "started",
    );

    assert(receipt, "started_receipt_missing");
    await this.until(
      async () => {
        const result = await docker([
          "ps",
          "--filter",
          `name=^/${receipt.container}$`,
          "--format",
          "{{.Names}}",
        ]);

        return result.trim();
      },
      (value) => value === receipt.container,
      "worker_not_running",
    );
    await ownedContainer(receipt.container);
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

    const spec = sandboxExecutionSpecSchema.parse(
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

  async artifact(receipt: z.infer<typeof storedReceiptSchema>) {
    const query = new URLSearchParams({
      workspace: "fixtures",
      key: JSON.stringify(receipt.executionKey),
      attempt: String(receipt.attempt),
      path: "effects",
    });

    const result = await this.provider(sandboxArtifactSchema, `/artifacts?${query}`);

    return Buffer.from(result.bytes, "base64").toString("utf8");
  }

  async assertSingleAttempt(snapshot: RunSnapshotView) {
    const own = (await receipts()).filter(
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
    const responses = await Promise.all([
      this.provider(sandboxReceiptSchema, "/attempts", request),
      this.provider(sandboxReceiptSchema, "/attempts", request),
    ]);

    assert(
      responses.every((response) => response.kind === kind),
      "duplicate_admission_changed_receipt",
    );
  }

  async check(name: string, action: () => Promise<Evidence>) {
    const start = Date.now();

    try {
      this.results.push({
        name,
        status: "passed",
        durationMs: Date.now() - start,
        evidence: await action(),
      });
      const result = this.results.at(-1);

      if (result) {
        result.durationMs = Date.now() - start;
      }
    } catch (cause) {
      this.results.push({
        name,
        status: "failed",
        durationMs: Date.now() - start,
        evidence:
          cause instanceof JourneyFailure
            ? cause.evidence
            : {
                failure: "unexpected_test_error",
                errorType: cause instanceof Error ? cause.name : "non_error",
              },
      });
    }

    await this.save();
    process.stdout.write(`${JSON.stringify(this.results.at(-1))}\n`);
  }

  async save(extra: Evidence = {}) {
    await mkdir(resolve(root, ".notes/cloud/evidence"), { recursive: true });
    await Bun.write(
      resolve(root, ".notes/cloud/evidence/failures.json"),
      `${JSON.stringify(
        {
          status: this.results.some((result) => result.status === "failed") ? "failed" : "passed",
          scope: "actual-local-wrangler-and-docker-only",
          command: "bun --no-env-file scripts/cloud/failures.ts",
          api,
          sandbox,
          stateRoot: state,
          dockerContext: "colima-loopy-cloud-phase1",
          image: "loopy-sandbox:bun-1.4.0",
          startedAt: this.startedAt,
          updatedAt: new Date().toISOString(),
          runIds: this.runs,
          results: this.results,
          gaps: [
            "No remote deployment or provider tested.",
            "No Docker CLI transport fault injected in the real Docker journey.",
            "No completion push endpoint exists. Late completion is exercised by recovery of the durable finished provider receipt.",
          ],
          ...extra,
        },
        null,
        2,
      )}\n`,
    );
  }
}
