import type { JsonObject } from "@loopy/contracts";
import type { ProviderEvent, ProviderRegistry } from "@loopy/providers";
import type { ProviderExecutionContext, ProviderExecutor } from "./runtime.js";

export type ProviderExecutorOptions = {
  registry: ProviderRegistry;
  /** Receives normalized provider events for trace persistence. */
  onEvent?: (event: ProviderEvent) => void | Promise<void>;
};

function providerFor(node: ProviderExecutionContext["node"]): string {
  const direct = node.provider;
  if (typeof direct === "string" && direct.trim()) return direct;
  const configuration = node.configuration;
  if (configuration && typeof configuration === "object") {
    const configured = (configuration as Record<string, unknown>).provider;
    if (typeof configured === "string" && configured.trim()) return configured;
  }
  throw new Error(`Agent node '${node.id}' does not declare a provider.`);
}

function promptFor(node: ProviderExecutionContext["node"], input: JsonObject): string | undefined {
  const direct = node.prompt;
  if (typeof direct === "string") return direct;
  const configuration = node.configuration;
  if (configuration && typeof configuration === "object") {
    const prompt = (configuration as Record<string, unknown>).prompt;
    if (typeof prompt === "string") return prompt;
  }
  return Object.keys(input).length > 0 ? JSON.stringify(input) : undefined;
}

/** Bridges the provider-neutral runtime contract to registered local CLI adapters. */
export function createProviderExecutor(options: ProviderExecutorOptions): ProviderExecutor {
  const active = new Map<string, { cancel(): Promise<void> }>();
  return {
    async execute(context) {
      const providerId = providerFor(context.node);
      const adapter = options.registry.get(providerId);
      if (!adapter)
        return { status: "failed", error: `Provider '${providerId}' is not registered.` };
      const configuration = context.node.configuration;
      const configured =
        configuration && typeof configuration === "object"
          ? (configuration as Record<string, unknown>)
          : {};
      const run = await adapter.start({
        runId: context.runId,
        attemptId: context.attemptId,
        nodeId: context.nodeId,
        input: context.input,
        prompt: promptFor(context.node, context.input),
        cwd: typeof configured.cwd === "string" ? configured.cwd : undefined,
        model: typeof configured.model === "string" ? configured.model : undefined,
        reasoning: typeof configured.reasoning === "string" ? configured.reasoning : undefined,
        metadata: {
          provider: providerId,
          ...(configured.sessionId && typeof configured.sessionId === "string"
            ? { sessionId: configured.sessionId }
            : {}),
        },
        signal: context.signal,
      });
      active.set(context.attemptId, run);
      const events: ProviderEvent[] = [];
      try {
        for await (const event of run.events) {
          events.push(event);
          await options.onEvent?.(event);
        }
        const session = await run.session;
        const ended = [...events].reverse().find((event) => event.type === "session_ended");
        const failed = ended?.payload?.status === "failed";
        const cancelled = context.signal.aborted || ended?.payload?.status === "cancelled";
        const lastMessage = [...events].reverse().find((event) => event.type === "message");
        const usage = [...events].reverse().find((event) => event.type === "usage")?.usage;
        const outputs: JsonObject = {
          provider: providerId,
          sessionId: session.sessionId,
          eventCount: events.length,
          ...(lastMessage?.payload?.content !== undefined
            ? { message: lastMessage.payload.content }
            : {}),
          ...(usage ? { usage } : {}),
        };
        if (cancelled) return { status: "cancelled", outputs, summary: "Provider run cancelled." };
        if (failed)
          return {
            status: "failed",
            outputs,
            error:
              typeof ended?.payload?.error === "string"
                ? ended.payload.error
                : "Provider run failed.",
          };
        return { status: "succeeded", outputs, summary: "Provider run completed." };
      } finally {
        active.delete(context.attemptId);
      }
    },
    async cancel(attemptId) {
      await active.get(attemptId)?.cancel();
    },
  };
}
