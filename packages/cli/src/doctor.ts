import {
  assertHonestCapabilityReport,
  type CapabilityReport,
  createDefaultProviderRegistry,
  type ProviderAdapter,
  type ProviderProbe,
  type ProviderRegistry,
} from "@loopy/providers";

export type DoctorResult = {
  providers: ProviderProbe[];
  malformedConfiguration: boolean;
};

function safeDiagnostic(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s,"'}]+/gi, "$1=[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[REDACTED]");
}

export async function runDoctor(registry: ProviderRegistry): Promise<DoctorResult> {
  const providers: ProviderProbe[] = [];
  let malformedConfiguration = false;
  for (const adapter of registry.all()) {
    try {
      const probe = await adapter.probe();
      try {
        assertHonestCapabilityReport(probe.capabilities);
      } catch (error) {
        malformedConfiguration = true;
        providers.push({
          ...probe,
          available: false,
          diagnostic: safeDiagnostic(`Malformed capability report: ${String(error)}`),
          configurationError: true,
        });
        continue;
      }
      providers.push({ ...probe, diagnostic: safeDiagnostic(probe.diagnostic) });
      malformedConfiguration ||= probe.configurationError === true;
    } catch (error) {
      // A provider that cannot probe is a malformed adapter/configuration. An
      // ordinary missing executable must be represented by probe.available=false.
      malformedConfiguration = true;
      providers.push({
        provider: adapter.id,
        available: false,
        version: adapter.version,
        capabilities: safeFallbackCapabilities(adapter),
        diagnostic: safeDiagnostic(`Probe failed: ${String(error)}`),
        configurationError: true,
      });
    }
  }
  return { providers, malformedConfiguration };
}

function safeFallbackCapabilities(adapter: ProviderAdapter): CapabilityReport {
  try {
    const report = adapter.capabilities();
    assertHonestCapabilityReport(report);
    return report;
  } catch {
    return {
      schemaVersion: "1",
      capabilities: {},
      supported: [],
      degraded: [],
      unavailable: [],
    };
  }
}

export function formatDoctor(result: DoctorResult, json = false): string {
  if (json) return JSON.stringify(result, null, 2);
  const lines = ["Loopy provider doctor"];
  if (!result.providers.length) lines.push("No providers registered.");
  for (const provider of result.providers) {
    const status = provider.available ? "available" : "unavailable";
    const capabilities = [
      ...provider.capabilities.supported.map((name) => `${name}=supported`),
      ...provider.capabilities.degraded.map((name) => `${name}=degraded`),
      ...provider.capabilities.unavailable.map((name) => `${name}=unavailable`),
    ];
    lines.push(`${provider.provider}: ${status}`);
    if (provider.path || provider.executable)
      lines.push(`  cli: ${provider.path ?? provider.executable}`);
    if (provider.version) lines.push(`  version: ${provider.version}`);
    if (capabilities.length) lines.push(`  capabilities: ${capabilities.join(", ")}`);
    if (provider.diagnostic) lines.push(`  diagnostic: ${provider.diagnostic}`);
  }
  if (result.malformedConfiguration) lines.push("Configuration errors detected.");
  return lines.join("\n");
}

export async function doctorCommand(
  registry: ProviderRegistry = createDefaultProviderRegistry(),
  options: { json?: boolean; log?: (line: string) => void } = {},
): Promise<number> {
  const result = await runDoctor(registry);
  (options.log ?? console.log)(formatDoctor(result, options.json));
  return result.malformedConfiguration ? 1 : 0;
}
