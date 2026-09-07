import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkflowDefinitionSchema } from "@loopy/contracts";
import { startServer } from "../../server/src/index";
import {
  type ExtractionJobRecord,
  type ExtractionReviewRecord,
  type ImportedSessionRecord,
  SqliteRuntimeStore,
  type WorkflowVersionRecord,
} from "../../storage/src/index";
import { encodeTraceJsonl } from "../../tracing/src/index";
import { type AcceptanceProvider, acceptanceProviders } from "./product-recovery";

class ReviewRequired extends Error {}

const provider = process.argv[2] as AcceptanceProvider;
const model = process.argv[3];
if (process.env.LOOPY_LIVE_ACCEPTANCE !== "1")
  throw new Error("Set LOOPY_LIVE_ACCEPTANCE=1 to invoke paid coding calls.");
assert(acceptanceProviders.includes(provider) && model, "Supply provider and explicit model");
assert(provider !== "codex" || model === "gpt-5.6-luna", "Codex requires gpt-5.6-luna low");
const resumeProject = process.env.LOOPY_ACCEPTANCE_PROJECT;
const project = resumeProject ?? mkdtempSync(resolve(tmpdir(), `loopy-coding-${provider}-`));
if (!resumeProject) {
  mkdirSync(resolve(project, "_tests_"));
  writeFileSync(
    resolve(project, "index.html"),
    "<html><head></head><body>Acceptance</body></html>",
  );
  writeFileSync(
    resolve(project, "greeting.ts"),
    'export function greet(name: string): string { throw new Error("not implemented"); }\n',
  );
  writeFileSync(
    resolve(project, "_tests_/greeting.test.ts"),
    'import { test, expect } from "bun:test";\nimport { greet } from "../greeting";\nimport expected from "../expected.json";\ntest("greets different names", () => { for (const name of ["Ada", "Lin"]) expect(greet(name)).toBe(expected.prefix + ", " + name + "!"); });\n',
  );
  writeFileSync(resolve(project, "expected.json"), JSON.stringify({ prefix: "Hello" }));
  for (const args of [
    ["init", "-q"],
    ["add", "greeting.ts", "_tests_", "expected.json"],
    [
      "-c",
      "user.name=Loopy Acceptance",
      "-c",
      "user.email=acceptance@localhost",
      "commit",
      "-qm",
      "Seed acceptance task",
    ],
  ]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: project });
    assert.equal(result.exitCode, 0, result.stderr.toString());
  }
}
const server = await startServer({ projectDir: project, studioDir: project });
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
const testSource = await Bun.file(resolve(project, "_tests_/greeting.test.ts")).text();
const evidence: Record<string, unknown> = {
  provider,
  model,
  project,
  mode: "live-provider",
  browserVerified: false,
  status: "running",
};
try {
  type Review = ExtractionReviewRecord & { proposalHash: string };
  let review: Review;
  let job: ExtractionJobRecord;
  if (resumeProject) {
    const previous = await Bun.file(resolve(project, "acceptance.json")).json();
    Object.assign(evidence, previous, { status: "running" });
    review = await api<Review>(`/extractions/${previous.extractionJobId}`);
    job = review.job;
  } else {
    const fixture = await Bun.file(
      new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
    ).json();
    const agent = crypto.randomUUID(),
      verify = crypto.randomUUID();
    const definition = WorkflowDefinitionSchema.parse({
      ...fixture,
      id: crypto.randomUUID(),
      name: `Live coding acceptance ${provider}`,
      inputs: [{ name: "task", type: "string", required: true }],
      nodes: [
        {
          id: agent,
          name: "Implement task",
          kind: "agent",
          provider,
          model,
          ...(provider === "codex" ? { reasoning: "low" } : {}),
          prompt:
            "Implement the supplied task in greeting.ts. Do not alter tests or expected.json. Run bun test and report the result. Use your editing tools for changes. Keep work confined to this project.",
          inputBindings: { task: { kind: "workflow_input", name: "task" } },
        },
        {
          id: verify,
          name: "Verify implementation",
          kind: "verify",
          commands: [{ command: "bun", args: ["test", "_tests_"] }],
        },
      ],
      edges: [{ id: crypto.randomUUID(), source: agent, target: verify, metadata: {} }],
      defaults: {
        ...fixture.defaults,
        provider,
        model,
        ...(provider === "codex" ? { reasoning: "low" } : {}),
        timeoutMs: 120000,
        retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
      },
      policies: {
        ...fixture.policies,
        sandbox: provider === "codex" ? "workspace-write" : undefined,
        tools: { allow: [], deny: [], network: "unrestricted" },
        budget: { timeoutMs: 120000 },
        workspace: {
          useGitWorktree: false,
          allowDirtyWorkspace: true,
          writableRoots: provider === "codex" ? [project] : [],
          workingDirectory: project,
        },
      },
    });
    await api("/workflows", { definition });
    const first = await api<{ id: string }>("/runs", {
      workflowId: definition.id,
      input: {
        task: "Implement greet(name) to return Hello, followed by a space, the name, and an exclamation mark. Example: Hello, Ada!",
      },
    });
    evidence.firstRunId = first.id;
    const completed = await server.runtime.wait(first.id);
    assert.equal(
      completed.run.status,
      "succeeded",
      JSON.stringify(
        completed.attempts.map((a) => ({ nodeId: a.nodeId, status: a.status, error: a.error })),
      ),
    );
    assert.equal(completed.attempts.find((a) => a.nodeId === verify)?.status, "succeeded");
    assert.equal(
      await Bun.file(resolve(project, "_tests_/greeting.test.ts")).text(),
      testSource,
      "Agent modified acceptance tests",
    );
    assert.deepEqual(await Bun.file(resolve(project, "expected.json")).json(), { prefix: "Hello" });
    const events = new SqliteRuntimeStore(server.storage).listTraceEvents(first.id);
    assert(
      events.some((event) => event.type === "provider.message"),
      "missing prompt/message evidence",
    );
    const content = encodeTraceJsonl(events);
    await Bun.write(resolve(project, "first-trace.jsonl"), content);
    const imported = await api<ImportedSessionRecord>("/sessions", {
      provider,
      source: "first-trace.jsonl",
      content,
    });
    const repeated = await api<ImportedSessionRecord>("/sessions", {
      provider,
      source: "first-trace.jsonl",
      content,
    });
    assert.equal(imported.id, repeated.id);
    job = await api<ExtractionJobRecord>("/extractions", { importId: imported.id });
    evidence.extractionJobId = job.id;
    review = await api<Review>(`/extractions/${job.id}`);
    await Bun.write(resolve(project, "extraction-review.json"), JSON.stringify(review, null, 2));
    assert(
      review.proposal.workflow.nodes.some((node) => node.kind === "agent"),
      "Extraction did not recover coding work",
    );
    assert(
      review.proposal.workflow.nodes.some((node) => node.kind === "verify"),
      "Extraction did not recover verification",
    );
    assert(
      review.proposal.workflow.inputs.some((input) => input.name === "task" && input.required),
      "Extraction needs a required reusable task input",
    );
  }
  let published: WorkflowVersionRecord;
  if (review.proposal.status === "approved") {
    const existing = server.storage.runtime.getWorkflowVersion(
      review.proposal.workflow.id,
      review.proposal.workflow.workflowVersion,
    );
    assert(existing, "Approved extraction workflow version is missing");
    published = existing;
  } else {
    // Resolutions come from inspection of the saved proposal; they are never guessed.
    const resolutionPath = process.env.LOOPY_ACCEPTANCE_RESOLUTIONS;
    if (!resolutionPath)
      throw new ReviewRequired(
        `Review ${resolve(project, "extraction-review.json")} and supply LOOPY_ACCEPTANCE_RESOLUTIONS. No workflow was published.`,
      );
    const resolutions: unknown = await Bun.file(resolutionPath).json();
    const reviewed = await api<Review>(`/extractions/${job.id}/review`, {
      expectedProposalHash: review.proposalHash,
      resolutions,
      resolvedBy: "acceptance-review",
      allowNetworkAccess: process.env.LOOPY_ACCEPTANCE_ALLOW_NETWORK === "1",
      workflow: {
        ...review.proposal.workflow,
        defaults: {
          ...review.proposal.workflow.defaults,
          timeoutMs: 120000,
          provider,
          model,
          ...(provider === "codex" ? { reasoning: "low" } : {}),
        },
      },
    });
    assert(!reviewed.proposal.unresolvedQuestions.some((question) => question.blocksExecution));
    published = await api<WorkflowVersionRecord>(`/extractions/${job.id}/approve`, {
      expectedProposalHash: reviewed.proposalHash,
    });
  }
  evidence.workflowId = published.workflowId;
  writeFileSync(resolve(project, "expected.json"), JSON.stringify({ prefix: "Welcome" }));
  const stage = Bun.spawnSync(["git", "add", "greeting.ts", "expected.json"], { cwd: project });
  assert.equal(stage.exitCode, 0, stage.stderr.toString());
  const stagedDiff = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: project });
  assert([0, 1].includes(stagedDiff.exitCode), stagedDiff.stderr.toString());
  if (stagedDiff.exitCode === 1) {
    const commit = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Loopy Acceptance",
        "-c",
        "user.email=acceptance@localhost",
        "commit",
        "-qm",
        "Set second task expectation",
      ],
      { cwd: project },
    );
    assert.equal(commit.exitCode, 0, commit.stderr.toString());
  }
  const second = await api<{ id: string }>("/runs", {
    workflowId: published.workflowId,
    version: published.version,
    input: {
      task: "Change greet(name) to return Welcome, followed by a space, the name, and an exclamation mark. Example: Welcome, Ada! Do not alter tests or expected.json. Run bun test.",
    },
  });
  evidence.secondRunId = second.id;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const snapshot = await server.runtime.snapshot(second.id);
    const gate = snapshot.attempts.find((a) => a.status === "blocked_approval");
    if (gate) await server.runtime.approve(second.id, gate.nodeId, "approved", gate.attemptId);
    if (["succeeded", "failed", "cancelled"].includes(snapshot.run.status)) break;
    await Bun.sleep(100);
  }
  const secondResult = await server.runtime.snapshot(second.id);
  assert.equal(secondResult.run.status, "succeeded");
  assert(
    secondResult.attempts.some(
      (a) =>
        WorkflowDefinitionSchema.parse(published.definition).nodes.some(
          (node) => node.id === a.nodeId && node.kind === "agent",
        ) && a.status === "succeeded",
    ),
  );
  const workingDirectory = secondResult.run.plan.policies?.workspace?.workingDirectory;
  assert.equal(typeof workingDirectory, "string");
  assert.equal(
    await Bun.file(resolve(workingDirectory as string, "_tests_/greeting.test.ts")).text(),
    testSource,
    "Agent modified acceptance tests",
  );
  assert.deepEqual(await Bun.file(resolve(workingDirectory as string, "expected.json")).json(), {
    prefix: "Welcome",
  });
  const verification = Bun.spawnSync([process.execPath, "test", "_tests_"], {
    cwd: workingDirectory as string,
  });
  assert.equal(verification.exitCode, 0, verification.stderr.toString());
  evidence.status = "passed";
} catch (error) {
  evidence.status = error instanceof ReviewRequired ? "awaiting_review" : "failed";
  evidence.error = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ReviewRequired)) throw error;
} finally {
  await Bun.write(resolve(project, "acceptance.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  await server.stop();
}
