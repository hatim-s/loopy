import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodexProviderAdapter,
  runSubprocess,
  SubprocessError,
  startJsonlSubprocess,
} from "../src/index.ts";

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
  const root = mkdtempSync(join(tmpdir(), "loopy-hung-probe-"));
  try {
    const script = join(root, "provider-shim.ts");
    await Bun.write(script, "setTimeout(() => process.exit(), 3000);\n");
    const provider = createCodexProviderAdapter({
      executable: process.execPath,
      commandPrefixArgs: [script],
      probeTimeoutMs: 30,
    });
    const started = Date.now();
    expect((await provider.probe()).available).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal leader exit drains its descendants before done and later cancel is a no-op", async () => {
  const root = mkdtempSync(join(tmpdir(), "loopy-late-cancel-"));
  const marker = join(root, "late");
  try {
    const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>Bun.write(${JSON.stringify(marker)},'bad'),300);setTimeout(()=>process.exit(),400)`;
    const live = startJsonlSubprocess({
      argv: [
        process.execPath,
        "-e",
        `Bun.spawn([process.execPath,'-e',${JSON.stringify(descendant)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});setTimeout(()=>process.exit(),80)`,
      ],
      cwd: root,
      gracefulTerminationMs: 40,
    });
    const started = Date.now();
    const result = await live.done;
    expect(result.aborted).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    await live.cancel();
    await Bun.sleep(300);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const jsonl of [false, true]) {
  test(`forced pipe drain reports incomplete output without killing another process group, JSONL ${jsonl}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "loopy-inherited-pipe-"));
    const marker = join(root, "finished");
    try {
      const descendant = `setTimeout(()=>{Bun.write(${JSON.stringify(marker)},'done');console.log('{"tail":true}');},350);setTimeout(()=>process.exit(),450)`;
      const options = {
        argv: [
          process.execPath,
          "-e",
          `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','inherit','inherit']});child.unref();console.log('{}');setTimeout(()=>process.exit(),80)`,
        ] as const,
        cwd: root,
        gracefulTerminationMs: 30,
      };
      const started = Date.now();
      if (jsonl) {
        const live = startJsonlSubprocess(options);
        const result = await live.done;
        expect(result.outputIncomplete).toBe(true);
        expect(result.diagnostic).toContain("incomplete");
      } else {
        try {
          await runSubprocess(options);
          throw new Error("Incomplete output was accepted");
        } catch (error) {
          expect(error).toBeInstanceOf(SubprocessError);
          expect((error as SubprocessError).result?.outputIncomplete).toBe(true);
        }
      }
      expect(Date.now() - started).toBeLessThan(1000);
      await Bun.sleep(500);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test(`normal exit drains inherited pipes and stops resistant descendants, JSONL ${jsonl}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "loopy-normal-exit-"));
    const marker = join(root, "late");
    try {
      const descendant = `process.on('SIGTERM',()=>console.log('{"tail":true}'));setTimeout(()=>Bun.write(${JSON.stringify(marker)},'bad'),300);setTimeout(()=>process.exit(),450)`;
      const options = {
        argv: [
          process.execPath,
          "-e",
          `Bun.spawn([process.execPath,'-e',${JSON.stringify(descendant)}],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});console.log('{}');setTimeout(()=>process.exit(),80)`,
        ] as const,
        cwd: root,
        gracefulTerminationMs: 40,
      };
      const started = Date.now();
      const lines: string[] = [];
      const live = jsonl ? startJsonlSubprocess(options) : undefined;
      const collecting = live
        ? (async () => {
            for await (const line of live.lines) lines.push(line);
          })()
        : Promise.resolve();
      const result = await (live?.done ?? runSubprocess(options));
      await collecting;
      expect(Date.now() - started).toBeLessThan(1500);
      expect(result).toMatchObject({ aborted: false, timedOut: false, exitCode: 0 });
      expect(result.stdout).toContain('{"tail":true}');
      if (jsonl) expect(lines).toContain('{"tail":true}');
      await Bun.sleep(320);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
