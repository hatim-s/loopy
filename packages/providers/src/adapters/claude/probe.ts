import {
  type ProviderCapabilitiesV1,
  type ProviderInstallationV1,
  SCHEMA_VERSION_V1,
} from "@loopy/contracts";
import { buildClaudeCommand } from "./command.js";
import type { ClaudeProbeRunner } from "./types.js";

export type ClaudeCapabilityReport = {
  provider: "claude";
  version?: string;
  capabilities: ProviderCapabilitiesV1;
  degraded: Array<{ capability: string; reason: string }>;
};

export function parseClaudeVersion(output: string): string | undefined {
  const match =
    output.match(/\b(?:claude(?:-code)?|@anthropic-ai\/claude-code)\s+v?(\d+(?:\.\d+){1,3})\b/i) ??
    output.match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/);
  return match?.[1];
}

export function buildClaudeCapabilities(
  options: { version?: string; forwardSubagentText?: boolean } = {},
): ProviderCapabilitiesV1 {
  const nested = options.forwardSubagentText ?? true;
  return {
    schemaVersion: SCHEMA_VERSION_V1,
    provider: "claude",
    structuredStreamingEvents: true,
    historicalSessionImport: true,
    sessionResume: true,
    sessionFork: false,
    explicitModelSelection: true,
    explicitReasoningLevel: false,
    toolAllowlist: true,
    writablePathPolicy: false,
    networkPolicy: false,
    maxTurns: true,
    tokenBudget: false,
    monetaryBudget: true,
    timeoutCancellation: true,
    usageReporting: true,
    nestedSubagentVisibility: nested,
    nativeSandbox: false,
    notes: [
      "Claude stream-json is consumed with --verbose so tool and lifecycle records remain correlated.",
      "Permission mode and tool allow/deny options are provider controls; OS-level workspace/network isolation remains separate.",
      ...(nested
        ? []
        : ["The installed Claude Code version does not expose forward-subagent-text."]),
      ...(options.version ? [`Observed Claude Code version ${options.version}.`] : []),
    ],
  };
}

export function buildClaudeCapabilityReport(
  options: { version?: string; forwardSubagentText?: boolean } = {},
): ClaudeCapabilityReport {
  const capabilities = buildClaudeCapabilities(options);
  return {
    provider: "claude",
    ...(options.version ? { version: options.version } : {}),
    capabilities,
    degraded: [
      {
        capability: "sessionFork",
        reason: "Claude Code CLI exposes resume, not a native fork operation.",
      },
      {
        capability: "writablePathPolicy",
        reason: "Workspace path restrictions require OS/runtime isolation.",
      },
      {
        capability: "networkPolicy",
        reason: "Network policy is outside Claude permission-mode flags.",
      },
      ...(options.forwardSubagentText === false
        ? [
            {
              capability: "nestedSubagentVisibility",
              reason: "Installed Claude Code version does not expose forward-subagent-text.",
            },
          ]
        : []),
    ],
  };
}

export function buildClaudeInstallation(options: {
  installed: boolean;
  version?: string;
  path?: string;
  executable?: string;
  detectedAt?: string;
  diagnostic?: string;
  capabilities?: ProviderCapabilitiesV1;
}): ProviderInstallationV1 {
  const version = options.version;
  return {
    schemaVersion: SCHEMA_VERSION_V1,
    provider: "claude",
    installed: options.installed,
    ...(options.executable ? { executable: options.executable } : {}),
    ...(version ? { version } : {}),
    ...(options.path ? { path: options.path } : {}),
    detectedAt: options.detectedAt ?? new Date().toISOString(),
    capabilities: options.capabilities ?? buildClaudeCapabilities({ version }),
    ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
  };
}

/** Claude is intentionally probed through an injected runner; local fixtures document unavailable installations. */
export async function probeClaude(
  runner: ClaudeProbeRunner,
  options: { detectedAt?: string } = {},
): Promise<ProviderInstallationV1> {
  const command = buildClaudeCommand({ prompt: "probe" });
  const result = await runner([command.executable, "--version"]);
  const output = `${result.stdout}${result.stderr ?? ""}`.trim();
  const version = result.exitCode === 0 ? parseClaudeVersion(output) : undefined;
  const installed = result.exitCode === 0 && version !== undefined;
  return buildClaudeInstallation({
    installed,
    version,
    executable: command.executable,
    detectedAt: options.detectedAt,
    diagnostic: installed
      ? undefined
      : `claude unavailable: ${output || `exit ${result.exitCode}`}`,
  });
}
