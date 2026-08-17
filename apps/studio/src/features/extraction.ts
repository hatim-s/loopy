export type { ExtractionReviewProps } from "./components.tsx";
export {
  ExtractionReview,
  extractionApproveMutation,
  extractionRejectMutation,
} from "./components.tsx";
export type { EvidenceLink, ExtractionReviewModel } from "./types.ts";

export function extractionReviewQuery(importId: string) {
  return {
    kind: "query" as const,
    key: ["extraction", importId] as const,
    endpoint: `/api/extractions/${encodeURIComponent(importId)}`,
  };
}
