import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@loopy/contracts";
import { SqliteRuntimeStore, Storage } from "@loopy/storage";
import { codingTrace } from "../../extractor/_tests_/coding-fixture.ts";
import { createExtractionService } from "../src/extraction.ts";

test("only an unchanged stored native run trace inherits its recorded workspace root", async () => {
  const project = mkdtempSync(join(tmpdir(), "loopy-extraction-root-"));
  const storage = new Storage({ projectDir: project });
  try {
    const store = new SqliteRuntimeStore(storage);
    const session = codingTrace("opencode");
    const request = session[3];
    if (request?.type !== "tool.requested") throw new Error("Missing fixture request");
    request.payload.input = { command: "bun test", cwd: "/source/packages/service" };
    const workflowId = randomUUID();
    await store.commit([
      {
        type: "create_run",
        run: {
          runId: request.runId,
          workflowId,
          workflowVersion: 1,
          inputs: {},
          status: "succeeded",
          createdAt: request.occurredAt,
          plan: {
            workflowId,
            workflowVersion: 1,
            nodes: [],
            edges: [],
            policies: { workspace: { workingDirectory: "/source" } },
          },
        },
      },
    ]);
    for (const event of session) store.appendTraceEvent(request.runId, event);
    const service = createExtractionService(storage);
    for (const changed of [false, true]) {
      const importedEvents = structuredClone(session);
      if (changed) importedEvents[0]!.occurredAt = "2026-09-09T00:00:00.000Z";
      const imported = storage.runtime.createImportedSession({
        provider: "opencode",
        source: "trace.jsonl",
        session: importedEvents as unknown as JsonValue,
      });
      const job = await service.extract(imported.id);
      const review = storage.runtime.getExtractionReview(job.id);
      if (!review) throw new Error("Missing extraction review");
      const verify = review.proposal.workflow.nodes.find((node) => node.kind === "verify");
      if (changed) expect(verify).toBeUndefined();
      else {
        expect(verify).toMatchObject({ commands: [{ cwd: "packages/service" }] });
        expect(review.audit).toMatchObject({
          sourceWorkspaceRoots: { [request.runId]: "/source" },
        });
      }
    }
  } finally {
    storage.close();
    rmSync(project, { recursive: true, force: true });
  }
});
