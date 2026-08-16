import { capabilityReport, createProviderRegistry, type ProviderAdapter } from "@loopy/providers";
import { describe, expect, it, vi } from "vitest";
import { doctorCommand, runDoctor } from "../src";

function adapter(available: boolean, configurationError = false): ProviderAdapter {
  return {
    id: available ? "installed" : "missing",
    version: "1.0.0",
    capabilities: () =>
      capabilityReport({
        sessionResume: available
          ? { status: "supported" }
          : { status: "unavailable", reason: "CLI is not installed" },
      }),
    probe: async () => ({
      provider: available ? "installed" : "missing",
      available,
      version: available ? "1.2.3" : undefined,
      executable: available ? "/bin/provider" : "provider",
      capabilities: capabilityReport({
        sessionResume: available
          ? { status: "supported" }
          : { status: "unavailable", reason: "CLI is not installed" },
      }),
      configurationError,
      diagnostic: available ? undefined : "Optional executable is not installed.",
    }),
    start: async () => {
      throw new Error("not exercised");
    },
    historicalImports: [],
  };
}

describe("loopy doctor", () => {
  it("does not fail for a missing optional CLI", async () => {
    const result = await runDoctor(createProviderRegistry([adapter(false)]));
    expect(result.malformedConfiguration).toBe(false);
    expect(await doctorCommand(createProviderRegistry([adapter(false)]), { log: vi.fn() })).toBe(0);
  });

  it("fails only malformed configuration", async () => {
    const result = await doctorCommand(createProviderRegistry([adapter(true, true)]), {
      log: vi.fn(),
    });
    expect(result).toBe(1);
  });
});
