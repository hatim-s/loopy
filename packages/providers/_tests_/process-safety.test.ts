import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexProviderAdapter, startJsonlSubprocess } from "../src/index.ts";

test("await cancel stops a resistant descendant even when its leader exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "loopy-provider-safety-"));
  const marker = join(root, "late");
  try {
    const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>Bun.write(${JSON.stringify(marker)},'bad'),250);setTimeout(()=>process.exit(),350)`;
    const live = startJsonlSubprocess({
      argv: [
        process.execPath,
        "-e",
        `Bun.spawn([process.execPath,'-e',${JSON.stringify(descendant)}]);console.log('{}');setTimeout(()=>process.exit(),500)`,
      ],
      cwd: root,
      gracefulTerminationMs: 30,
    });
    for await (const _line of live.lines) break;
    await Bun.sleep(35);
    await live.cancel();
    expect((await live.done).aborted).toBe(true);
    await Bun.sleep(300);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("hung version probe returns unavailable within a bounded deadline", async () => {
  const provider = createCodexProviderAdapter({
    executable: process.execPath,
    commandPrefixArgs: ["-e", "setTimeout(()=>process.exit(),3000)"],
    probeTimeoutMs: 30,
  });
  const started = Date.now();
  expect((await provider.probe()).available).toBe(false);
  expect(Date.now() - started).toBeLessThan(2000);
});
