import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkflowDefinitionSchema } from "@loopy/contracts";
import type { ProviderExecutor } from "@loopy/runtime";
import { startServer } from "../../server/src/index";

export const acceptanceProviders = ["codex", "claude", "pi", "opencode"] as const;
export type AcceptanceProvider = (typeof acceptanceProviders)[number];

/** Runs real shells and SQLite recovery. An injected provider makes the agent calls offline. */
export async function runProductRecovery(options: {
  providerId: AcceptanceProvider;
  model: string;
  provider?: ProviderExecutor;
  retain?: boolean;
}) {
  const project = mkdtempSync(resolve(tmpdir(), "loopy-product-acceptance-"));
  writeFileSync(
    resolve(project, "index.html"),
    "<html><head></head><body>Acceptance</body></html>",
  );
  const git = Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  assert.equal(git.exitCode, 0, git.stderr.toString());
  let server = await startServer({
    projectDir: project,
    studioDir: project,
    provider: options.provider,
  });
  const evidence: Array<{ input: string; runId: string; agentAttemptId: string; status: string }> =
    [];
  try {
    for (const text of ["pass", "fail"]) {
      const [agent, route, green, red, join, retry, verify, approval] = Array.from(
        { length: 8 },
        () => crypto.randomUUID(),
      ) as [string, string, string, string, string, string, string, string];
      const edge = (source: string, target: string, label?: string) => ({
        id: crypto.randomUUID(),
        source,
        target,
        label,
        metadata: {},
      });
      const fixture = await Bun.file(
        new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
      ).json();
      const definition = WorkflowDefinitionSchema.parse({
        ...fixture,
        id: crypto.randomUUID(),
        name: `Acceptance ${options.providerId} ${text}`,
        inputs: [{ name: "text", type: "string", required: true }],
        nodes: [
          {
            id: agent,
            kind: "agent",
            name: "Classify input",
            provider: options.providerId,
            model: options.model,
            ...(options.providerId === "codex" ? { reasoning: "low" } : {}),
            prompt:
              "Read workflow input text. Reply exactly GREEN if text is pass, otherwise reply exactly RED. Do not call tools or modify files.",
            inputBindings: { text: { kind: "workflow_input", name: "text" } },
          },
          {
            id: route,
            kind: "route",
            name: "Choose branch",
            predicate: {
              kind: "comparison",
              operator: "equals",
              left: {
                kind: "reference",
                reference: { kind: "node_output", nodeId: agent, path: ["message"] },
              },
              right: { kind: "literal", value: "GREEN" },
            },
          },
          ...[green, red].map((id) => ({
            id,
            kind: "shell",
            name: id === green ? "Green branch" : "Red branch",
            execution: "host",
            stages: ["cat", "tr A-Z a-z"],
            inputBindings: { stdin: { kind: "node_output", nodeId: agent, path: ["message"] } },
          })),
          {
            id: join,
            kind: "join",
            name: "Join branch",
            policy: "any",
            outputMode: "first_success",
          },
          {
            id: retry,
            kind: "shell",
            name: "Fail then retry",
            execution: "host",
            stages: [
              `if ! test -f ${text}.attempted; then touch ${text}.attempted; exit 7; fi; printf RETRY_OK`,
            ],
          },
          {
            id: verify,
            kind: "verify",
            name: "Verify retry artifact",
            commands: [{ command: "test", args: ["-f", `${text}.attempted`] }],
          },
          {
            id: approval,
            kind: "approval",
            name: "Review result",
            message: "Approve this acceptance result",
            approvalKey: "acceptance",
          },
        ],
        edges: [
          edge(agent, route),
          edge(route, green, "true"),
          edge(route, red, "false"),
          edge(green, join),
          edge(red, join),
          edge(join, retry),
          edge(retry, verify),
          edge(verify, approval),
        ],
        defaults: {
          ...fixture.defaults,
          retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
          timeoutMs: 120000,
        },
        policies: {
          ...fixture.policies,
          tools: { allow: [], deny: [], network: "unrestricted" },
          budget: { timeoutMs: 120000 },
          workspace: {
            useGitWorktree: false,
            allowDirtyWorkspace: true,
            workingDirectory: project,
            writableRoots: options.providerId === "codex" ? [project] : [],
          },
        },
      });
      const started = await server.runtime.start(definition, { text });
      const failed = await server.runtime.wait(started.runId);
      assert.equal(failed.run.status, "failed");
      const agentAttempt = failed.attempts.find((a) => a.nodeId === agent);
      assert.equal(
        agentAttempt?.status,
        "succeeded",
        agentAttempt?.error ?? "Agent attempt did not succeed",
      );
      assert.equal(agentAttempt?.output?.message, text === "pass" ? "GREEN" : "RED");
      assert.equal(
        failed.attempts.find((a) => a.nodeId === (text === "pass" ? green : red))?.output?.stdout,
        text === "pass" ? "green" : "red",
      );
      assert.equal(
        failed.attempts.find((a) => a.nodeId === (text === "pass" ? red : green))?.status,
        "skipped",
      );
      assert.equal(failed.attempts.find((a) => a.nodeId === retry)?.output?.exitCode, 7);
      await server.runtime.retry(started.runId, retry);
      const deadline = Date.now() + 10000;
      let snapshot = await server.runtime.snapshot(started.runId);
      while (
        !snapshot.attempts.some((a) => a.nodeId === approval && a.status === "blocked_approval") &&
        Date.now() < deadline
      ) {
        await Bun.sleep(10);
        snapshot = await server.runtime.snapshot(started.runId);
      }
      const gate = snapshot.attempts.find(
        (a) => a.nodeId === approval && a.status === "blocked_approval",
      );
      assert(gate, "retry must reach approval");
      assert.equal(snapshot.attempts.find((a) => a.nodeId === verify)?.status, "succeeded");
      await server.runtime.pause(started.runId);
      await server.stop();
      server = await startServer({
        projectDir: project,
        studioDir: project,
        provider: options.provider,
      });
      const recovered = await server.runtime.snapshot(started.runId);
      assert.equal(recovered.run.status, "paused");
      assert.deepEqual(
        recovered.attempts.filter((a) => a.nodeId === agent),
        [agentAttempt],
      );
      assert.equal(
        recovered.attempts.find((a) => a.nodeId === approval)?.attemptId,
        gate.attemptId,
      );
      await assert.rejects(
        server.runtime.approve(started.runId, approval, "approved", gate.attemptId),
        /active running run/,
      );
      await server.runtime.resume(started.runId);
      await server.runtime.approve(
        started.runId,
        approval,
        text === "pass" ? "approved" : "rejected",
        gate.attemptId,
      );
      const finished = await server.runtime.wait(started.runId);
      assert.equal(finished.run.status, text === "pass" ? "succeeded" : "failed");
      assert.deepEqual(
        finished.attempts.filter((a) => a.nodeId === agent),
        [agentAttempt],
      );
      assert.deepEqual(
        finished.attempts.filter((a) => a.nodeId === retry).map((a) => a.output?.exitCode),
        [7, 0],
      );
      assert(agentAttempt);
      evidence.push({
        input: text,
        runId: started.runId,
        agentAttemptId: agentAttempt.attemptId,
        status: finished.run.status,
      });
    }
    return {
      mode: options.provider ? "offline-scripted-provider" : "live-provider",
      provider: options.providerId,
      model: options.model,
      project: options.retain ? project : undefined,
      cases: evidence,
      browserVerified: false,
      extractionVerified: false,
    };
  } finally {
    await server.stop();
    if (!options.retain) rmSync(project, { recursive: true, force: true });
  }
}
