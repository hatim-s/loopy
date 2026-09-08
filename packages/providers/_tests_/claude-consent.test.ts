import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createClaudeProviderAdapter } from "../src";

test("Claude maps explicit allowed tools without adding a permission bypass", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "loopy-claude-consent-"));
  try {
    const marker = resolve(directory, "argv.json");
    const adapter = createClaudeProviderAdapter({
      executable: process.execPath,
      commandPrefixArgs: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(1)))`,
        "--",
      ],
    });
    for (const allow of [[], ["Read", "Edit", "Write", "Bash"]]) {
      const policy = { tools: { allow, deny: ["WebFetch"], network: "unrestricted" as const } };
      const before = JSON.stringify(policy);
      const run = await adapter.start({
        runId: "consent",
        attemptId: "consent",
        nodeId: "consent",
        input: {},
        prompt: "edit fixture",
        policy,
      });
      const session = run.session.catch(() => undefined);
      for await (const _event of run.events) {
        /* Drain the CLI shim. */
      }
      await session;
      const args: string[] = JSON.parse(readFileSync(marker, "utf8"));
      expect(args.includes("--allowedTools")).toBe(allow.length > 0);
      if (allow.length) {
        expect(args[args.indexOf("--allowedTools") + 1]).toBe(allow.join(","));
        expect(args[args.indexOf("--tools") + 1]).toBe(allow.join(","));
      }
      expect(args[args.indexOf("--disallowedTools") + 1]).toBe("WebFetch");
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--permission-mode");
      expect(JSON.stringify(policy)).toBe(before);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
