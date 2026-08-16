import {
  type ProviderCapabilitiesV1,
  type ProviderInstallationV1,
  SCHEMA_VERSION_V1,
} from "@loopy/contracts";
import { buildCodexCommand } from "./command.js";
import type { CodexCapabilitiesOptions, CodexProbeResult, CodexProbeRunner } from "./types.js";

export const CODEX_KNOWN_VERSION = "0.146.0";

export type CodexCapabilityReport = {
  provider: "codex";
  version?: string;
  capabilities: ProviderCapabilitiesV1;
  degraded: Array<{ capability: string; reason: string }>;
};

export function parseCodexVersion(output: string): string | undefined {
  const match =
    output.match(/\b(?:codex-cli|codex)\s+v?(\d+(?:\.\d+){1,3})\b/i) ??
    output.match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/);
  return match?.[1];
}

export function buildCodexCapabilities(
  options: CodexCapabilitiesOptions = {},
): ProviderCapabilitiesV1 {
  const nested = options.nestedSubagentVisibility ?? true;
  return {
    schemaVersion: SCHEMA_VERSION_V1,
    provider: "codex",
    structuredStreamingEvents: true,
    historicalSessionImport: true,
    sessionResume: true,
    sessionFork: false,
    explicitModelSelection: true,
    explicitReasoningLevel: false,
    toolAllowlist: false,
    writablePathPolicy: true,
    networkPolicy: false,
    maxTurns: false,
    tokenBudget: false,
    monetaryBudget: false,
    timeoutCancellation: true,
    usageReporting: true,
    nestedSubagentVisibility: nested,
    nativeSandbox: true,
    notes: [
      "Codex JSONL is normalized from the installed codex exec --json surface.",
      "Codex exposes sandbox modes, but no portable per-tool allowlist or network policy flag is assumed.",
      ...(nested
        ? []
        : ["Nested subagent events are not exposed by this installed Codex version."]),
      ...(options.version ? [`Observed codex-cli version ${options.version}.`] : []),
    ],
  };
}

export function buildCodexCapabilityReport(
  options: CodexCapabilitiesOptions = {},
): CodexCapabilityReport {
  const capabilities = buildCodexCapabilities(options);
  return {
    provider: "codex",
    ...(options.version ? { version: options.version } : {}),
    capabilities,
    degraded: [
      {
        capability: "sessionFork",
        reason: "Codex CLI exposes resume, not a native fork operation.",
      },
      { capability: "toolAllowlist", reason: "Codex CLI has no portable per-tool allowlist flag." },
      {
        capability: "networkPolicy",
        reason: "Network policy is outside the Codex CLI sandbox flags.",
      },
      { capability: "monetaryBudget", reason: "Codex CLI does not expose a monetary budget flag." },
      ...(options.nestedSubagentVisibility === false
        ? [
            {
              capability: "nestedSubagentVisibility",
              reason: "Installed Codex version does not expose nested subagent events.",
            },
          ]
        : []),
    ],
  };
}

export function buildCodexInstallation(options: {
  installed: boolean;
  version?: string;
  path?: string;
  executable?: string;
  detectedAt?: string;
  diagnostic?: string;
  capabilities?: ProviderCapabilitiesV1;
}): ProviderInstallationV1 {
  const detectedAt = options.detectedAt ?? new Date().toISOString();
  const version = options.version ?? undefined;
  return {
    schemaVersion: SCHEMA_VERSION_V1,
    provider: "codex",
    installed: options.installed,
    ...(options.executable ? { executable: options.executable } : {}),
    ...(version ? { version } : {}),
    ...(options.path ? { path: options.path } : {}),
    detectedAt,
    capabilities: options.capabilities ?? buildCodexCapabilities({ version }),
    ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
  };
}

/** Probe through an injected runner so adapters remain deterministic and testable. */
export async function probeCodex(
  runner: CodexProbeRunner,
  options: { detectedAt?: string } = {},
): Promise<CodexProbeResult> {
  const versionCommand = buildCodexCommand({ prompt: undefined });
  const result = await runner([versionCommand.executable, "--version"]);
  const versionOutput = `${result.stdout}${result.stderr ?? ""}`.trim();
  const version = result.exitCode === 0 ? parseCodexVersion(versionOutput) : undefined;
  const installed = result.exitCode === 0 && version !== undefined;
  return {
    versionOutput,
    installation: buildCodexInstallation({
      installed,
      version,
      executable: versionCommand.executable,
      detectedAt: options.detectedAt,
      diagnostic: installed
        ? undefined
        : `codex unavailable: ${versionOutput || `exit ${result.exitCode}`}`,
    }),
  };
}
