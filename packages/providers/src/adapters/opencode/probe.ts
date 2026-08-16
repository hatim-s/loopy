import type { ProviderInstallation } from "@loopy/contracts";
import { buildOpenCodeCapabilities } from "./capabilities.js";
import type { OpenCodeProbeResult } from "./types.js";

export function parseOpenCodeVersion(output: string): string | undefined {
  const match = output.match(/(?:opencode\s+)?v?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/i);
  return match?.[1];
}

export type OpenCodeCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{
  stdout?: string;
  stderr?: string;
  exitCode: number;
}>;

export async function probeOpenCode(
  run?: OpenCodeCommandRunner,
  now = () => new Date().toISOString(),
): Promise<OpenCodeProbeResult> {
  const detectedAt = now();
  let result: Awaited<ReturnType<OpenCodeCommandRunner>>;
  try {
    result = await (
      run ?? (async () => ({ exitCode: 127, stderr: "opencode: command not found" }))
    )("opencode", ["--version"]);
  } catch (error) {
    result = { exitCode: 127, stderr: error instanceof Error ? error.message : String(error) };
  }
  const version = parseOpenCodeVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const installed = result.exitCode === 0 && Boolean(version);
  const capabilities = buildOpenCodeCapabilities(version);
  const installation: ProviderInstallation = {
    schemaVersion: "1",
    provider: "opencode",
    installed,
    ...(version ? { version } : {}),
    ...(installed ? {} : { diagnostic: result.stderr?.trim() || "OpenCode CLI was not found." }),
    detectedAt,
    capabilities,
  };
  return { ...installation, capabilities };
}

export const probe = probeOpenCode;
