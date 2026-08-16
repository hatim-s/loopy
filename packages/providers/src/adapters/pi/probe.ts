import type { ProviderInstallation } from "@loopy/contracts";
import { buildPiCapabilities } from "./capabilities.js";
import type { PiProbeResult } from "./types.js";

export function parsePiVersion(output: string): string | undefined {
  const match = output.match(/(?:pi\s+)?v?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/i);
  return match?.[1];
}
export type PiCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout?: string; stderr?: string; exitCode: number }>;
export async function probePi(
  run?: PiCommandRunner,
  now = () => new Date().toISOString(),
): Promise<PiProbeResult> {
  const detectedAt = now();
  let result: Awaited<ReturnType<PiCommandRunner>>;
  try {
    result = await (run ?? (async () => ({ exitCode: 127, stderr: "pi: command not found" })))(
      "pi",
      ["--version"],
    );
  } catch (error) {
    result = { exitCode: 127, stderr: error instanceof Error ? error.message : String(error) };
  }
  const version = parsePiVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const installed = result.exitCode === 0 && Boolean(version);
  const capabilities = buildPiCapabilities(version);
  const installation: ProviderInstallation = {
    schemaVersion: "1",
    provider: "pi",
    installed,
    ...(version ? { version } : {}),
    ...(installed ? {} : { diagnostic: result.stderr?.trim() || "Pi CLI was not found." }),
    detectedAt,
    capabilities,
  };
  return { ...installation, capabilities };
}
export const probe = probePi;
