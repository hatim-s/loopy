import type { JsonValue } from "@loopy/contracts";
import { extractImportedSession } from "@loopy/extractor";
import { ApiError } from "@loopy/local-api";
import type { ExtractionJobRecord, Storage } from "@loopy/storage";

export function createExtractionService(storage: Storage) {
  for (const job of storage.runtime.listExtractionJobs()) {
    if (job.status === "queued" || job.status === "running")
      storage.runtime.updateExtractionJob(job.id, {
        status: "failed",
        error: "Extraction interrupted by server restart; extract the session again.",
      });
  }
  const active = new Map<string, Promise<ExtractionJobRecord>>();
  const extract = async (importId: string) => {
    const imported = storage.runtime.getImportedSession(importId);
    if (!imported) throw new ApiError(404, "not_found", "Imported session not found");
    const job = storage.runtime.createExtractionJob({
      importId,
      input: { source: imported.source },
    });
    try {
      storage.runtime.updateExtractionJob(job.id, { status: "running" });
      const extraction = await extractImportedSession({
        id: importId,
        provider: imported.provider,
        session: imported.session,
        capabilities: imported.capabilities,
        lossiness: imported.lossiness,
      });
      if (!extraction.result.ok)
        throw new Error(extraction.result.diagnostics.map((item) => item.code).join(", "));
      return storage.runtime.saveExtractionResult(job.id, {
        proposal: extraction.result.proposal,
        audit: extraction.audit as unknown as JsonValue,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      storage.runtime.updateExtractionJob(job.id, { status: "failed", error: message });
      throw new ApiError(422, "extraction_failed", message);
    }
  };
  return {
    extract(importId: string) {
      let pending = active.get(importId);
      if (!pending) {
        pending = extract(importId).finally(() => active.delete(importId));
        active.set(importId, pending);
      }
      return pending;
    },
    async drain() {
      await Promise.allSettled(active.values());
    },
  };
}
