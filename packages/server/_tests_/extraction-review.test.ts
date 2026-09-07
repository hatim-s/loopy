import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
  ExtractionJobRecord,
  ExtractionReviewRecord,
  ImportedSessionRecord,
} from "@loopy/storage";
import { startServer } from "../src/index";

test("review edits persist answers, reject stale writes and preserve commands and approval policies", async () => {
  const project = mkdtempSync(resolve(tmpdir(), "loopy-review-"));
  writeFileSync(resolve(project, "index.html"), "<html><head></head></html>");
  const server = await startServer({ projectDir: project, studioDir: project });
  const request = async (path: string, body?: unknown) =>
    fetch(`${server.url}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const events = await Bun.file(
      new URL("../../../fixtures/sessions/successful.json", import.meta.url),
    ).json();
    const imported = (await (
      await request("/sessions", {
        provider: "codex",
        source: "successful.json",
        content: events.map((event: unknown) => JSON.stringify(event)).join("\n"),
      })
    ).json()) as ImportedSessionRecord;
    const job = (await (
      await request("/extractions", { importId: imported.id })
    ).json()) as ExtractionJobRecord;
    const stored = server.storage.runtime.getExtractionReview(job.id)!;
    // A real blocked draft remains unavailable for approval until its question is resolved.
    server.storage.runtime.saveExtractionResult(job.id, {
      proposal: {
        ...stored.proposal,
        unresolvedQuestions: [
          { question: "Confirm local changes", blocksExecution: true },
          { question: "The provider cannot enforce network isolation.", blocksExecution: true },
        ],
      },
      audit: {},
    });
    const review = (await (
      await request(`/extractions/${job.id}`)
    ).json()) as ExtractionReviewRecord;
    expect(
      (
        await request(`/extractions/${job.id}/approve`, {
          expectedProposalHash: review.proposalHash,
        })
      ).ok,
    ).toBe(false);
    const workflow = structuredClone(review.proposal.workflow);
    workflow.name = "Reviewed coding task";
    expect((await request(`/extractions/${job.id}/approve`, {})).ok).toBe(false);
    expect(
      (
        await request(`/extractions/${job.id}/review`, {
          expectedProposalHash: review.proposalHash,
          resolutions: [
            { question: "The provider cannot enforce network isolation.", answer: "Reviewed" },
          ],
        })
      ).status,
    ).toBe(409);
    const editedResponse = await request(`/extractions/${job.id}/review`, {
      expectedProposalHash: review.proposalHash,
      resolutions: [
        { question: "Confirm local changes", answer: "Local project edits authorized" },
        {
          question: "The provider cannot enforce network isolation.",
          answer: "Provider network access allowed",
        },
      ],
      workflow,
      allowNetworkAccess: true,
    });
    expect(editedResponse.status).toBe(200);
    const edited = (await editedResponse.json()) as ExtractionReviewRecord;
    expect(edited.proposalHash).not.toBe(review.proposalHash);
    expect(edited.proposal.workflow.policies.tools.network).toBe("unrestricted");
    expect(edited.proposal.unresolvedQuestions[0]?.blocksExecution).toBe(false);
    expect(JSON.stringify(edited.audit)).toContain("Local project edits authorized");
    expect(
      (
        await request(`/extractions/${job.id}/review`, {
          expectedProposalHash: review.proposalHash,
          resolutions: [],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/extractions/${job.id}/approve`, {
          expectedProposalHash: review.proposalHash,
        })
      ).ok,
    ).toBe(false);
    workflow.policies.tools.network = "restricted";
    expect(
      (
        await request(`/extractions/${job.id}/review`, {
          expectedProposalHash: edited.proposalHash,
          resolutions: [],
          workflow,
        })
      ).status,
    ).toBe(409);
    expect((await request(`/extractions/${job.id}/reject`, { reason: "Scope changed" })).ok).toBe(
      true,
    );
    const rejected = (await (
      await request(`/extractions/${job.id}`)
    ).json()) as ExtractionReviewRecord;
    expect(rejected.proposal.status).toBe("rejected");
    expect(JSON.stringify(rejected.audit)).toContain("Scope changed");
    expect(
      (
        await request(`/extractions/${job.id}/review`, {
          expectedProposalHash: rejected.proposalHash,
          resolutions: [],
        })
      ).status,
    ).toBe(409);
  } finally {
    await server.stop();
    rmSync(project, { recursive: true, force: true });
  }
});
