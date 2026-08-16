import { describe, expect, test } from "bun:test";
import { createDefaultProviderRegistry } from "../src/index.js";

describe("registered providers", () => {
  test("registers exactly the four supported provider IDs", () => {
    expect(
      createDefaultProviderRegistry()
        .all()
        .map((adapter) => adapter.id),
    ).toEqual(["codex", "claude", "opencode", "pi"]);
  });

  test.skipIf(process.env.LOOPY_LIVE_PROVIDER_PROBES !== "1")(
    "opt-in live probes record the machine's installed provider versions",
    async () => {
      const result = await Promise.all(
        createDefaultProviderRegistry()
          .all()
          .map((adapter) => adapter.probe()),
      );
      expect(result.map((probe) => probe.provider)).toEqual(["codex", "claude", "opencode", "pi"]);
      for (const probe of result) {
        expect(probe.capabilities.schemaVersion).toBe("1");
        if (probe.available) {
          expect(probe.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
        } else {
          expect(probe.version).toBeUndefined();
          expect(probe.diagnostic).toBeTruthy();
        }
      }
    },
  );
});
