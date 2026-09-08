import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDefaultProviderRegistry } from "../src";

test("all four launch the child in the policy working directory", async () => {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), "loopy-provider-cwd-")));
  try {
    const marker = resolve(directory, "cwd.txt");
    const options = {
      executable: process.execPath,
      commandPrefixArgs: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},process.cwd())`,
        "--",
      ],
    };
    const registry = createDefaultProviderRegistry({
      codex: options,
      claude: options,
      pi: options,
      opencode: options,
    });
    for (const adapter of registry.all()) {
      const run = await adapter.start({
        runId: "cwd",
        attemptId: "cwd",
        nodeId: "cwd",
        input: {},
        prompt: "cwd",
        policy: { workspace: { workingDirectory: directory }, tools: { network: "unrestricted" } },
      });
      const session = run.session.catch(() => undefined);
      for await (const _event of run.events) {
        /* Drain the shim process. */
      }
      await session;
      expect(readFileSync(marker, "utf8")).toBe(directory);
      rmSync(marker);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
