import type { ProviderCapabilities } from "@loopy/contracts";

export function buildPiCapabilities(version?: string): ProviderCapabilities {
  const notes = [
    "Historical session JSONL import is explicitly versioned and unstable; this adapter currently accepts session file version 3.",
    "Pi tool controls map to --tools, --exclude-tools, and --no-tools; filesystem and network path policies are not emulated.",
  ];
  if (!version)
    notes.push(
      "Provider version was not detected; capabilities use the known Pi 0.80.x CLI surface.",
    );
  return {
    schemaVersion: "1",
    provider: "pi",
    structuredStreamingEvents: true,
    historicalSessionImport: true,
    sessionResume: true,
    sessionFork: false,
    explicitModelSelection: true,
    explicitReasoningLevel: true,
    toolAllowlist: true,
    writablePathPolicy: false,
    networkPolicy: false,
    maxTurns: false,
    tokenBudget: false,
    monetaryBudget: false,
    timeoutCancellation: true,
    usageReporting: true,
    nestedSubagentVisibility: false,
    nativeSandbox: false,
    notes,
  };
}

export const piCapabilities = buildPiCapabilities;
