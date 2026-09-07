import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type TraceEvent, WorkflowDefinitionSchema } from "@loopy/contracts";
import { createDefaultProviderRegistry } from "@loopy/providers";
import { createProviderExecutor } from "@loopy/runtime";
import { startServer } from "../../server/src/index";
import type {
  ExtractionJobRecord,
  ExtractionReviewRecord,
  ImportedSessionRecord,
  WorkflowVersionRecord,
} from "../../storage/src/index";
import { encodeTraceJsonl } from "../../tracing/src/index";
import { acceptanceProviders } from "./product-recovery";

// This command consumes the native-format fixtures from the four-provider implementation.
// It uses a scripted coding executor and real Git, SQLite, HTTP review and Bun verification.
const fixtureRoot =
  process.argv[2] ?? new URL("../../providers/_tests_/fixtures", import.meta.url).pathname;
const failures: Array<{ provider: string; error: string }> = [];
for (const provider of acceptanceProviders) {
  const project = mkdtempSync(resolve(tmpdir(), `loopy-native-acceptance-${provider}-`));
  mkdirSync(resolve(project, "_tests_"));
  writeFileSync(resolve(project, "index.html"), "<html><head></head></html>");
  writeFileSync(
    resolve(project, "greeting.ts"),
    'export const greet = (name: string) => "Hello, " + name + "!";\n',
  );
  writeFileSync(
    resolve(project, "_tests_/greeting.test.ts"),
    'import { test, expect } from "bun:test"; import { greet } from "../greeting"; test("current task", () => { expect(greet("Ada")).toBe("Welcome, Ada!"); expect(greet("Lin")).toBe("Welcome, Lin!"); });\n',
  );
  for (const args of [
    ["init", "-q"],
    ["add", "greeting.ts", "_tests_"],
    [
      "-c",
      "user.name=Acceptance",
      "-c",
      "user.email=acceptance@localhost",
      "commit",
      "-qm",
      "Seed second input",
    ],
  ]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: project });
    assert.equal(result.exitCode, 0, result.stderr.toString());
  }
  let calls = 0;
  const server = await startServer({
    projectDir: project,
    studioDir: project,
    provider: {
      async execute(context) {
        calls++;
        assert.equal(context.node.provider, provider);
        assert.equal(context.input.task, "Change greeting to Welcome for any supplied name.");
        const cwd = context.policy?.workspace?.workingDirectory;
        assert(cwd, "Execution worktree must be explicit");
        writeFileSync(
          resolve(cwd, "greeting.ts"),
          'export const greet = (name: string) => "Welcome, " + name + "!";\n',
        );
        return { status: "succeeded", outputs: { message: "Offline scripted edit completed" } };
      },
    },
  });
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert(response.ok, `${path}: ${JSON.stringify(value)}`);
    return value as T;
  };
  try {
    const nativeContent = await Bun.file(resolve(fixtureRoot, `${provider}-coding.jsonl`)).text();
    const shim = resolve(project, "replay.mjs");
    writeFileSync(shim, `process.stdout.write(${JSON.stringify(nativeContent)});`);
    const canonical: TraceEvent[] = [];
    const executor = createProviderExecutor({
      registry: createDefaultProviderRegistry({
        [provider]: { executable: process.execPath, commandPrefixArgs: [shim], cwd: project },
      }),
      onEvent(event) {
        canonical.push(event);
      },
    });
    const sourceRun = await executor.execute({
      runId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      nodeId: crypto.randomUUID(),
      node: {
        id: crypto.randomUUID(),
        kind: "agent",
        provider,
        prompt: "Update the greeting for the supplied name and run tests.",
      },
      input: {},
      signal: new AbortController().signal,
    });
    assert.equal(sourceRun.status, "succeeded");
    const content = encodeTraceJsonl(canonical);
    const imported = await api<ImportedSessionRecord>("/sessions", {
      provider,
      content,
      source: `${provider}-coding.jsonl`,
    });
    const job = await api<ExtractionJobRecord>("/extractions", { importId: imported.id });
    type Review = ExtractionReviewRecord & { proposalHash: string };
    const review = await api<Review>(`/extractions/${job.id}`);
    assert(review.proposal.workflow.nodes.some((node) => node.kind === "agent"));
    assert(
      review.proposal.workflow.nodes.some((node) => node.kind === "verify"),
      JSON.stringify({
        reason: "missing recovered verifier",
        nodes: review.proposal.workflow.nodes.map((node) => ({ kind: node.kind, name: node.name })),
        questions: review.proposal.unresolvedQuestions,
      }),
    );
    assert(
      review.proposal.workflow.inputs.some((input) => input.name === "task" && input.required),
    );
    assert.equal((await api<{ workflows: unknown[] }>("/workflows")).workflows.length, 0);
    const resolutions = review.proposal.unresolvedQuestions.map((question) => {
      assert(
        question.question.includes("may edit files") ||
          question.question.includes("cannot enforce network isolation") ||
          question.question.includes("Multiple user instructions were observed"),
        `Unexpected fixture boundary: ${question.question}`,
      );
      return {
        question: question.question,
        answer:
          "Reviewed synthetic fixture contains only a local greeting edit and bun test. Duplicate user instructions express the same greeting task; the required current task input defines the reusable scope. Allow local QA edits and provider network policy in this disposable test project; the injected provider performs no network requests.",
      };
    });
    const reviewed = await api<Review>(`/extractions/${job.id}/review`, {
      expectedProposalHash: review.proposalHash,
      resolutions,
      allowNetworkAccess: true,
    });
    const published = await api<WorkflowVersionRecord>(`/extractions/${job.id}/approve`, {
      expectedProposalHash: reviewed.proposalHash,
    });
    const workflow = WorkflowDefinitionSchema.parse(published.definition);
    const run = await api<{ id: string }>("/runs", {
      workflowId: published.workflowId,
      version: published.version,
      input: { task: "Change greeting to Welcome for any supplied name." },
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const snapshot = await server.runtime.snapshot(run.id);
      const gate = snapshot.attempts.find((attempt) => attempt.status === "blocked_approval");
      if (gate) await server.runtime.approve(run.id, gate.nodeId, "approved", gate.attemptId);
      if (["succeeded", "failed", "cancelled"].includes(snapshot.run.status)) break;
      await Bun.sleep(10);
    }
    const completed = await server.runtime.snapshot(run.id);
    assert.equal(completed.run.status, "succeeded", JSON.stringify(completed.attempts));
    assert.equal(calls, 1);
    for (const node of workflow.nodes.filter((node) => node.kind === "verify"))
      assert.equal(
        completed.attempts.find((attempt) => attempt.nodeId === node.id)?.status,
        "succeeded",
      );
    console.log(
      JSON.stringify({
        provider,
        mode: "offline-native-fixture-scripted-edit",
        status: "passed",
        realVerification: true,
        browserVerified: false,
      }),
    );
  } catch (error) {
    const failure = { provider, error: error instanceof Error ? error.message : String(error) };
    failures.push(failure);
    console.error(
      JSON.stringify({
        ...failure,
        mode: "offline-native-fixture-scripted-edit",
        status: "failed",
      }),
    );
  } finally {
    await server.stop();
    rmSync(project, { recursive: true, force: true });
  }
}

assert.equal(failures.length, 0, JSON.stringify(failures));
