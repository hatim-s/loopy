import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type ProviderId, TraceEventSchema } from "@loopy/contracts";
import { extractImportedSession } from "../src/index.ts";

export function codingTrace(provider: ProviderId = "codex", command = "bun test") {
  const identity = {
    runId: randomUUID(),
    nodeId: randomUUID(),
    attemptId: randomUUID(),
    provider,
    sessionId: "source-session",
  };
  let sequence = 0;
  const event = (type: string, payload: unknown, toolCallId?: string) =>
    TraceEventSchema.parse({
      schemaVersion: "1",
      id: randomUUID(),
      ...identity,
      sequence: sequence++,
      occurredAt: "2026-09-08T00:00:00.000Z",
      monotonicOffsetMs: sequence,
      type,
      payload,
      ...(toolCallId ? { toolCallId } : {}),
    });
  const editId = randomUUID();
  const verifyId = randomUUID();
  const editTool = { codex: "apply_patch", claude: "Edit", pi: "write", opencode: "edit" }[
    provider
  ];
  const shellTool = { codex: "command", claude: "Bash", pi: "bash", opencode: "bash" }[provider];
  return [
    event("provider.message", {
      role: "user",
      content: "Implement greeting.ts greet(name), returning Hello plus the name, and test it.",
    }),
    event(
      "tool.requested",
      {
        tool: editTool,
        input: {
          path: "greeting.ts",
          content: "export const greet = (name: string) => `Hello, ${name}!`;",
        },
      },
      editId,
    ),
    event("tool.completed", { output: "File updated", exitCode: 0 }, editId),
    event("tool.requested", { tool: shellTool, input: { command } }, verifyId),
    event("tool.completed", { output: "2 pass, 0 fail", exitCode: 0 }, verifyId),
    event("provider.session_ended", { status: "succeeded" }),
  ];
}

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
    expect(proposal.unresolvedQuestions).toHaveLength(2);
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
