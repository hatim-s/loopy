import { shellEnvironment } from "@loopy/workspace";

export type InstallOutcome = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};
export async function runInstaller(argv: string[], cwd: string): Promise<InstallOutcome> {
  const child = Bun.spawn(argv, {
    cwd,
    env: shellEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 600_000);
  let remaining = 128_000;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const keep = Math.min(remaining, value.byteLength);
        if (keep) output += decoder.decode(value.subarray(0, keep), { stream: true });
        remaining -= keep;
      }
      return output + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  };
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      read(child.stdout),
      read(child.stderr),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
