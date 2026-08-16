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
      const byId = new Map(result.map((probe) => [probe.provider, probe]));
      expect(byId.get("codex")?.available).toBe(true);
      expect(byId.get("codex")?.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(byId.get("pi")?.available).toBe(true);
      expect(byId.get("pi")?.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(byId.get("claude")?.available).toBe(false);
      expect(byId.get("opencode")?.available).toBe(false);
      expect(byId.get("claude")?.version).toBeUndefined();
      expect(byId.get("opencode")?.version).toBeUndefined();
    },
  );
});
