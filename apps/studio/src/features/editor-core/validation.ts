import { type WorkflowDefinition, WorkflowDefinitionSchema } from "@loopy/contracts";
import type { EditorValidationDiagnostic, ServerValidationResult } from "./types.ts";

export type DocumentDecodeResult =
  | { ok: true; document: WorkflowDefinition }
  | { ok: false; diagnostics: EditorValidationDiagnostic[] };

function diagnosticsFromZod(error: {
  issues: readonly { message: string; path: PropertyKey[] }[];
}): EditorValidationDiagnostic[] {
  return error.issues.map((issue) => ({
    code: "WORKFLOW_CONTRACT_INVALID",
    message: issue.message,
    path: `/${issue.path.map(String).join("/")}`,
    severity: "error",
  }));
}

export function decodeWorkflowDocument(input: unknown): DocumentDecodeResult {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "INVALID_JSON",
            message: error instanceof Error ? error.message : "Invalid JSON.",
            severity: "error",
          },
        ],
      };
    }
  }
  const parsed = WorkflowDefinitionSchema.safeParse(value);
  if (!parsed.success) return { ok: false, diagnostics: diagnosticsFromZod(parsed.error) };
  return { ok: true, document: parsed.data };
}

export function encodeWorkflowDocument(document: WorkflowDefinition, pretty = true): string {
  return JSON.stringify(document, null, pretty ? 2 : 0);
}

export function validationFromServer(result: ServerValidationResult): {
  status: "valid" | "invalid";
  diagnostics: EditorValidationDiagnostic[];
} {
  return {
    status: result.valid ? "valid" : "invalid",
    diagnostics: [...(result.diagnostics ?? [])],
  };
}
