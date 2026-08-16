import type { ProviderCapabilities } from "@loopy/contracts";

export function buildOpenCodeCapabilities(version?: string): ProviderCapabilities {
  const notes = [
    "The MVP consumes `opencode run --format json`; ACP is intentionally not used.",
    "Filesystem and network policy flags are not exposed by the run command and are not emulated.",
  ];
  if (!version)
    notes.push("Provider version was not detected; capability claims use the known CLI surface.");
  return {
    schemaVersion: "1",
    provider: "opencode",
    structuredStreamingEvents: true,
    historicalSessionImport: true,
    sessionResume: true,
    sessionFork: true,
    explicitModelSelection: true,
    explicitReasoningLevel: false,
    toolAllowlist: false,
    writablePathPolicy: false,
    networkPolicy: false,
    maxTurns: false,
    tokenBudget: false,
    monetaryBudget: false,
    timeoutCancellation: true,
    usageReporting: true,
    nestedSubagentVisibility: true,
    nativeSandbox: false,
    notes,
  };
}

export const opencodeCapabilities = buildOpenCodeCapabilities;
