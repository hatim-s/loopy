import { describe, expect, it } from "vitest";
import {
  parseCliVersion,
  runJsonlSubprocess,
  runSubprocess,
  SubprocessError,
  startJsonlSubprocess,
} from "../src";

const cwd = process.cwd();
const bun = process.execPath;

describe("provider subprocess core", () => {
  it("parses a semver from normal CLI version output", () => {
    expect(parseCliVersion("loopy-provider v1.2.3\n")).toBe("1.2.3");
    expect(parseCliVersion("version: 2.0.0-beta.1")).toBe("2.0.0-beta.1");
    expect(parseCliVersion("not installed")).toBeUndefined();
  });

  it("keeps malformed JSONL as diagnostics instead of silently dropping it", async () => {
    const result = await runJsonlSubprocess({
      argv: [bun, "-e", 'console.log("{\\"ok\\":true}"); console.log("not-json")'],
      cwd,
    });
    expect(result.records).toEqual([{ ok: true }]);
    expect(result.malformedLines).toHaveLength(1);
  });

  it("bounds stderr separately and never invokes a shell", async () => {
    await expect(
      runSubprocess({
        argv: [bun, "-e", 'console.error("secret=abc".repeat(100))'],
        cwd,
        maxStderrBytes: 16,
      }),
    ).rejects.toMatchObject({ name: "SubprocessError" });
    await expect(
      runSubprocess({
        argv: [bun, "-e", 'console.log(process.env.SECRET ?? "missing")'],
        cwd,
        env: { SECRET: "hidden" },
        envAllowlist: [],
      }),
    ).resolves.toMatchObject({ stdout: "missing\n" });
  });

  it("terminates a process on cancellation and reports it", async () => {
    const controller = new AbortController();
    const pending = runSubprocess({
      argv: [bun, "-e", "setTimeout(() => console.log('late'), 10000)"],
      cwd,
      signal: controller.signal,
      gracefulTerminationMs: 50,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).resolves.toMatchObject({ aborted: true });
  });

  it("diagnoses an unavailable executable", async () => {
    const error = await runSubprocess({ argv: ["loopy-no-such-provider-binary"], cwd }).catch(
      (value) => value,
    );
    expect(error).toBeInstanceOf(SubprocessError);
  });

  it("starts JSONL streaming before the child exits and cancels it", async () => {
    const live = startJsonlSubprocess({
      argv: [bun, "-e", 'console.log("first"); setTimeout(() => console.log("late"), 10000)'],
      cwd,
      gracefulTerminationMs: 50,
    });
    const iterator = live.lines[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: "first", done: false });
    await live.cancel();
    await expect(live.done).resolves.toMatchObject({ aborted: true });
  });

  it("terminates immediately when a JSONL line limit is crossed", async () => {
    const started = Date.now();
    await expect(
      runJsonlSubprocess({
        argv: [bun, "-e", 'for (let i=0;i<1000;i++) console.log("x")'],
        cwd,
        maxLines: 2,
        gracefulTerminationMs: 20,
      }),
    ).rejects.toMatchObject({ name: "SubprocessError", result: { limitExceeded: "lines" } });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
