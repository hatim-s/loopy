import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { extractImportedSession } from "../src/index.ts";
import { codingTrace } from "./coding-fixture.ts";

for (const provider of ["codex", "claude", "pi", "opencode"] as const) {
  test(`${provider} yields a task-bound implementation and evidenced verification`, async () => {
    const session = codingTrace(provider);
    const extraction = await extractImportedSession({ id: randomUUID(), provider, session });
    expect(extraction.result.ok).toBe(true);
    if (!extraction.result.ok) throw new Error(JSON.stringify(extraction.result.diagnostics));
    const proposal = extraction.result.proposal;
    expect(proposal.workflow.defaults.provider).toBe(provider);
    expect(proposal.workflow.inputs).toMatchObject([{ name: "task", required: true }]);
    expect(proposal.workflow.inputs[0]?.default).toBeUndefined();
    const agent = proposal.workflow.nodes.find((node) => node.kind === "agent");
    expect(agent?.kind).toBe("agent");
    if (agent?.kind !== "agent") throw new Error("No agent");
    expect(agent.inputBindings.task).toEqual({ kind: "workflow_input", name: "task" });
    expect(agent.prompt).not.toContain("Hello");
    expect(agent.prompt).not.toContain("greeting.ts");
    expect(proposal.workflow.nodes.find((node) => node.kind === "verify")).toMatchObject({
      commands: [{ command: "bun", args: ["test"] }],
    });
    expect(proposal.workflow.nodes[0]?.kind).toBe("approval");
    expect(extraction.audit.review.status).toBe("blocked");
    expect(proposal.unresolvedQuestions).toHaveLength(provider === "claude" ? 3 : 2);
    const ids = new Set(session.map((event) => event.id));
    expect(
      proposal.nodeEvidence.every((evidence) => evidence.eventIds.every((id) => ids.has(id))),
    ).toBe(true);
  });
}

test("unknown commands stay excluded and incomplete traces remain blocked", async () => {
  const session = codingTrace("codex", "bun test && git push").slice(0, -1);
  const extraction = await extractImportedSession({ id: randomUUID(), provider: "codex", session });
  expect(extraction.result.ok).toBe(true);
  if (!extraction.result.ok) throw new Error(JSON.stringify(extraction.result.diagnostics));
  expect(extraction.result.proposal.workflow.nodes.some((node) => node.kind === "verify")).toBe(
    false,
  );
  expect(
    extraction.result.proposal.unresolvedQuestions.map((item) => item.question).join(" "),
  ).toContain("did not report successful completion");
  expect(
    extraction.result.proposal.unresolvedQuestions.map((item) => item.question).join(" "),
  ).toContain("excluded from replay");
});

test("missing command completion never becomes successful verification", async () => {
  const session = codingTrace().filter((_, index) => index !== 4);
  const extraction = await extractImportedSession({ id: randomUUID(), provider: "codex", session });
  expect(extraction.result.ok).toBe(true);
  if (!extraction.result.ok) throw new Error(JSON.stringify(extraction.result.diagnostics));
  expect(extraction.result.proposal.workflow.nodes.some((node) => node.kind === "verify")).toBe(
    false,
  );
  expect(
    extraction.result.proposal.unresolvedQuestions.map((item) => item.question).join(" "),
  ).toContain("no observed completion");
});

test("verification never pairs results from a different attempt", async () => {
  const session = codingTrace();
  const result = session[4];
  if (!result) throw new Error("Missing fixture result");
  result.attemptId = randomUUID();
  const extraction = await extractImportedSession({ id: randomUUID(), provider: "codex", session });
  expect(extraction.result.ok).toBe(true);
  if (!extraction.result.ok) throw new Error(JSON.stringify(extraction.result.diagnostics));
  expect(extraction.result.proposal.workflow.nodes.some((node) => node.kind === "verify")).toBe(
    false,
  );
});

test("preserves the observed package manager and requires a successful check", async () => {
  const session = codingTrace("pi", "pnpm test");
  const extraction = await extractImportedSession({ id: randomUUID(), provider: "pi", session });
  if (!extraction.result.ok) throw new Error(JSON.stringify(extraction.result.diagnostics));
  expect(
    extraction.result.proposal.workflow.nodes.find((node) => node.kind === "verify"),
  ).toMatchObject({ commands: [{ command: "pnpm", args: ["test"] }] });
  const result = session[4];
  if (result?.type !== "tool.completed") throw new Error("Missing fixture result");
  result.payload.exitCode = 1;
  const failed = await extractImportedSession({ id: randomUUID(), provider: "pi", session });
  if (!failed.result.ok) throw new Error(JSON.stringify(failed.result.diagnostics));
  expect(failed.result.proposal.workflow.nodes.some((node) => node.kind === "verify")).toBe(false);
  expect(
    failed.result.proposal.unresolvedQuestions.some((question) =>
      question.question.includes("reported failure"),
    ),
  ).toBe(true);
});

for (const field of ["cwd", "workdir", "workingDirectory"]) {
  test(`preserves project-relative verifier ${field} and blocks unknown absolute mapping`, async () => {
    const session = codingTrace("codex", "npm test");
    const request = session[3];
    if (request?.type !== "tool.requested") throw new Error("Missing fixture request");
    request.payload.input = { command: "npm test", [field]: "packages/service" };
    const extraction = await extractImportedSession({
      id: randomUUID(),
      provider: "codex",
      session,
    });
    if (!extraction.result.ok) throw new Error(JSON.stringify(extraction.result.diagnostics));
    expect(
      extraction.result.proposal.workflow.nodes.find((node) => node.kind === "verify"),
    ).toMatchObject({ commands: [{ command: "npm", args: ["test"], cwd: "packages/service" }] });
    request.payload.input = { command: "npm test", [field]: "/repo/packages/service" };
    const absolute = await extractImportedSession({ id: randomUUID(), provider: "codex", session });
    if (!absolute.result.ok) throw new Error(JSON.stringify(absolute.result.diagnostics));
    expect(absolute.result.proposal.workflow.nodes.some((node) => node.kind === "verify")).toBe(
      false,
    );
    expect(
      absolute.result.proposal.unresolvedQuestions.some((question) =>
        question.question.includes("source working directory cannot be mapped"),
      ),
    ).toBe(true);
  });
}

test("maps absolute verification directories only within the recorded source run workspace", async () => {
  for (const [cwd, expected] of [
    ["/repo", "."],
    ["/repo/packages/service", "packages/service"],
    ["/private/repo/packages/service", "packages/service"],
    ["/private/repo-other", undefined],
    ["/private/repo/../outside", undefined],
    ["/repo-other", undefined],
    ["/other/repo", undefined],
    ["/repo/../outside", undefined],
  ] as const) {
    const session = codingTrace("opencode", "bun test");
    const request = session[3];
    if (request?.type !== "tool.requested") throw new Error("Missing fixture request");
    request.payload.input = { command: "bun test", cwd };
    const result = await extractImportedSession(
      { id: randomUUID(), provider: "opencode", session },
      { sourceWorkspaceRoots: { [request.runId]: ["/repo", "/private/repo"] } },
    );
    if (!result.result.ok) throw new Error(JSON.stringify(result.result.diagnostics));
    const verify = result.result.proposal.workflow.nodes.find((node) => node.kind === "verify");
    if (expected) expect(verify).toMatchObject({ commands: [{ cwd: expected }] });
    else expect(verify).toBeUndefined();
    const unrelated = await extractImportedSession(
      { id: randomUUID(), provider: "opencode", session },
      { sourceWorkspaceRoots: { [randomUUID()]: ["/repo"] } },
    );
    if (!unrelated.result.ok) throw new Error(JSON.stringify(unrelated.result.diagnostics));
    expect(unrelated.result.proposal.workflow.nodes.some((node) => node.kind === "verify")).toBe(
      false,
    );
  }
});
