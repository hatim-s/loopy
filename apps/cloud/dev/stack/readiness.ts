import type { Child } from "./launch";

export type Probe = () => Promise<boolean>;

export async function respondsOk(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(1000) });
  await response.body?.cancel();

  return response.ok;
}

export async function waitUntilReady(options: {
  children: readonly Child[];
  probes: readonly Probe[];
  timeoutMs: number;
  intervalMs: number;
  timeoutMessage: string;
}) {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    if (options.children.some((child) => child.exitCode !== null)) {
      throw new Error("An owned stack process exited before readiness. Inspect its local logs.");
    }

    // Owned services may still be binding their loopback ports, so transport errors mean not yet.
    const results = await Promise.all(options.probes.map((probe) => probe().catch(() => false)));

    if (results.every(Boolean)) {
      return;
    }

    await Bun.sleep(options.intervalMs);
  }

  throw new Error(options.timeoutMessage);
}
