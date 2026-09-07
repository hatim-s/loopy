import { realpathSync } from "node:fs";
import { ShellConfigurationSchema } from "@loopy/contracts";
import type { ProviderExecutor } from "@loopy/runtime";

// CLI-owned credentials remain on disk. Shells receive no ambient API tokens or shell hooks.
export function shellEnvironment(): Record<string, string> {
  const result: Record<string, string> = { TERM: "dumb", NO_COLOR: "1" };
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function createShellExecutor(options: { workingDirectory?: string } = {}): ProviderExecutor {
  return {
    async execute(context) {
      const config = ShellConfigurationSchema.parse(context.node.configuration ?? context.node);
      const workingDirectory =
        context.policy?.workspace?.workingDirectory ?? options.workingDirectory;
      if (!workingDirectory) throw new Error("Shell module requires a run workspace");
      if (context.signal.aborted) return { status: "cancelled", error: "Shell module cancelled" };
      const bash = Bun.which("bash");
      if (!bash) throw new Error("Bash is not installed on the server PATH");
      const input = context.input.stdin ?? context.input;
      const script = config.stages.map((stage) => `(\n${stage}\n)`).join(" | ");
      const child = Bun.spawn(
        [bash, "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
        {
          cwd: realpathSync(workingDirectory),
          env: shellEnvironment(),
          stdin: new Blob([typeof input === "string" ? input : JSON.stringify(input)]),
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        },
      );
      let reason: "timeout" | "cancelled" | "output_limit" | undefined;
      const terminate = (cause: NonNullable<typeof reason>) => {
        reason ??= cause;
        // Bash and all pipeline stages share the process group created by detached spawn.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* Already reaped. */
          }
        }
      };
      const abort = () => terminate("cancelled");
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) abort();
      const timer = setTimeout(() => terminate("timeout"), config.timeoutMs);
      let remaining = config.maxOutputBytes;
      const read = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const allowed = Math.min(remaining, value.byteLength);
            if (allowed) {
              parts.push(value.slice(0, allowed));
              size += allowed;
              remaining -= allowed;
            }
            if (allowed < value.byteLength) terminate("output_limit");
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        return new TextDecoder().decode(bytes);
      };
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          read(child.stdout),
          read(child.stderr),
        ]);
        const outputs = {
          stdout,
          stderr,
          exitCode,
          timedOut: reason === "timeout",
          truncated: reason === "output_limit",
        };
        if (reason === "cancelled")
          return { status: "cancelled", outputs, error: "Shell module cancelled" };
        if (reason || exitCode !== 0)
          return {
            status: "failed",
            outputs,
            error:
              reason === "timeout"
                ? "Shell module timeout"
                : reason === "output_limit"
                  ? "Shell module exceeded its output limit"
                  : `Shell module exited with code ${exitCode}`,
          };
        return {
          status: "succeeded",
          outputs,
          summary: `${config.stages.length} pipeline stages completed`,
        };
      } finally {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
      }
    },
  };
}
