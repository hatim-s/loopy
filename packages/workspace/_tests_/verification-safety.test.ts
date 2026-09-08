import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationContext } from "@loopy/runtime";
import { createShellVerifier } from "../src/index.ts";

const context = (script: string, extra: Record<string, unknown> = {}): VerificationContext => ({
  runId: "r",
  attemptId: "a",
  nodeId: "v",
  input: {},
  node: {
    id: "v",
    kind: "verify",
    commands: [{ command: process.execPath, args: ["-e", script], ...extra }],
  },
});

test("verification bounds shared output, records truncation, omits ambient secrets and canonicalizes cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "loopy-safety-"));
  const outside = mkdtempSync(join(tmpdir(), "loopy-outside-"));
  const previous = process.env.LOOPY_AUDIT_SENTINEL;
  process.env.LOOPY_AUDIT_SENTINEL = "synthetic";
  try {
    mkdirSync(join(root, "inside"));
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(root, "inside"), join(root, "link"));
    const verifier = createShellVerifier({ workingDirectory: root, maxOutputChars: 1 });
    await expect(verifier.verify(context("console.log('x')", { cwd: "escape" }))).rejects.toThrow(
      "escapes",
    );
    const safe = await createShellVerifier({ workingDirectory: root }).verify(
      context("console.log(process.env.LOOPY_AUDIT_SENTINEL ?? 'absent')", { cwd: "link" }),
    );
    expect(JSON.stringify(safe)).toContain("absent");
    expect(JSON.stringify(safe)).not.toContain("synthetic");
    const result = await verifier.verify(context("process.stdout.write('é'.repeat(10000))"));
    expect(result.details?.commands).toMatchObject([{ stdout: "", truncated: true }]);
  } finally {
    if (previous === undefined) delete process.env.LOOPY_AUDIT_SENTINEL;
    else process.env.LOOPY_AUDIT_SENTINEL = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("verification cancellation kills descendants and prevents subsequent commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "loopy-cancel-"));
  const marker = join(root, "late");
  const later = join(root, "second");
  try {
    const controller = new AbortController();
    const ctx = context(
      `Bun.spawn([process.execPath,'-e',${JSON.stringify(`setTimeout(()=>Bun.write(${JSON.stringify(marker)},'late'),250);setTimeout(()=>process.exit(),350)`)}]); process.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(),500)`,
    );
    ctx.signal = controller.signal;
    ctx.node.commands = [
      ...(ctx.node.commands as object[]),
      { command: process.execPath, args: ["-e", `Bun.write(${JSON.stringify(later)},'bad')`] },
    ];
    const pending = createShellVerifier({ workingDirectory: root }).verify(ctx);
    await Bun.sleep(70);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await Bun.sleep(300);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(later)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
