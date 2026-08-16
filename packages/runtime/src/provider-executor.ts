import type { JsonObject, JsonValue, TraceEvent } from "@loopy/contracts";
import { TraceEventSchema } from "@loopy/contracts";
import type { ProviderRegistry } from "@loopy/providers";
import type { ProviderExecutionContext, ProviderExecutor, ProviderPolicy } from "./runtime.js";

export type ProviderExecutorOptions = {
  registry: ProviderRegistry;
  /** Receives validated canonical trace envelopes suitable for persistence. */
  onEvent?: (event: TraceEvent) => void | Promise<void>;
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stableId(value: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    return value;
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex}${hex.slice(0, 4)}`;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Provider event is missing ${label}.`);
  return value;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  return String(value);
}

function canonicalProviderEvent(
  event: unknown,
  context: ProviderExecutionContext,
  provider: string,
  sequence: number,
): TraceEvent {
  const input = record(event);
  const fallbackSession = `${context.attemptId}-session`;
  const provenance = record(input.provenance);
  const sessionId =
    (typeof input.sessionId === "string" && input.sessionId) ||
    (typeof provenance.sessionId === "string" && provenance.sessionId) ||
    fallbackSession;
  const base = {
    schemaVersion: "1" as const,
    id: stableId(
      `${context.runId}:${context.attemptId}:${sequence}:${String(input.type ?? "event")}`,
    ),
    runId: stableId(context.runId),
    nodeId: stableId(context.nodeId),
    attemptId: stableId(context.attemptId),
    sequence,
    occurredAt:
      typeof input.occurredAt === "string" && input.occurredAt
        ? input.occurredAt
        : new Date().toISOString(),
    monotonicOffsetMs: typeof input.monotonicOffsetMs === "number" ? input.monotonicOffsetMs : 0,
    provider,
    sessionId,
    redaction: { status: "none" as const, removedFields: [] },
  };

  if (typeof input.schemaVersion === "string") {
    const candidate = {
      ...input,
      ...base,
      id: typeof input.id === "string" ? stableId(input.id) : base.id,
      runId: stableId(typeof input.runId === "string" ? input.runId : context.runId),
      nodeId: stableId(typeof input.nodeId === "string" ? input.nodeId : context.nodeId),
      attemptId: stableId(
        typeof input.attemptId === "string" ? input.attemptId : context.attemptId,
      ),
      provider: typeof input.provider === "string" ? input.provider : provider,
      sessionId: typeof input.sessionId === "string" ? input.sessionId : sessionId,
    };
    const parsed = TraceEventSchema.safeParse(candidate);
    if (!parsed.success)
      throw new Error(
        `Provider event failed TraceEventSchema validation: ${parsed.error.issues[0]?.message ?? "invalid event"}`,
      );
    return parsed.data;
  }

  const type = input.type;
  const payload = record(input.payload);
  let canonical: Record<string, unknown>;
  let toolCallId: string | undefined;
  switch (type) {
    case "session_started":
      canonical = {
        ...base,
        type: "provider.session_started",
        payload: {
          ...(typeof payload.parentSessionId === "string"
            ? { parentSessionId: payload.parentSessionId }
            : typeof provenance.parentSessionId === "string"
              ? { parentSessionId: provenance.parentSessionId }
              : {}),
        },
      };
      break;
    case "message": {
      const role = payload.role;
      if (role !== "user" && role !== "assistant" && role !== "system")
        throw new Error("Provider message event is missing a supported role.");
      canonical = {
        ...base,
        type: "provider.message",
        payload: {
          role,
          content: requiredText(payload.content ?? payload.message, "message content"),
        },
      };
      break;
    }
    case "usage":
      canonical = {
        ...base,
        type: "provider.usage",
        payload: { usage: payload.usage ?? input.usage },
      };
      break;
    case "session_ended": {
      const status = payload.status;
      if (status !== "succeeded" && status !== "failed" && status !== "cancelled")
        throw new Error("Provider session_ended event is missing a terminal status.");
      canonical = {
        ...base,
        type: "provider.session_ended",
        payload: { status, ...(typeof payload.error === "string" ? { error: payload.error } : {}) },
      };
      break;
    }
    case "subagent_started":
      canonical = {
        ...base,
        type: "provider.session_started",
        payload: {
          ...(typeof provenance.sessionId === "string"
            ? { parentSessionId: provenance.sessionId }
            : {}),
        },
      };
      break;
    case "subagent_ended":
      canonical = {
        ...base,
        type: "provider.session_ended",
        payload: {
          status:
            payload.status === "failed" || payload.status === "cancelled"
              ? payload.status
              : "succeeded",
          ...(typeof payload.error === "string" ? { error: payload.error } : {}),
        },
      };
      break;
    case "tool_call":
      toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
      canonical = {
        ...base,
        type: "tool.requested",
        toolCallId: stableId(toolCallId ?? `${context.attemptId}:tool:${sequence}`),
        payload: {
          tool: requiredText(payload.tool, "tool name"),
          input: jsonValue(payload.input ?? {}),
        },
      };
      break;
    case "tool_result":
      toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
      canonical = {
        ...base,
        type: "tool.completed",
        toolCallId: stableId(toolCallId ?? `${context.attemptId}:tool:${sequence}`),
        payload: { output: jsonValue(payload.output ?? payload.result ?? "") },
      };
      break;
    case "error":
      canonical = {
        ...base,
        type: "provider.session_ended",
        payload: {
          status: "failed",
          error: requiredText(payload.error ?? payload.message, "error message"),
        },
      };
      break;
    default:
      throw new Error(`Provider event type '${String(type)}' has no canonical trace mapping.`);
  }
  const parsed = TraceEventSchema.safeParse(canonical);
  if (!parsed.success)
    throw new Error(
      `Provider event failed TraceEventSchema validation: ${parsed.error.issues[0]?.message ?? "invalid event"}`,
    );
  return parsed.data;
}

function validatePolicy(policy: ProviderPolicy | undefined): string | undefined {
  if (policy === undefined) return undefined;
  const checkList = (value: unknown, name: string) =>
    value === undefined ||
    (Array.isArray(value) &&
      value.every((item) => typeof item === "string" && item.trim().length > 0))
      ? undefined
      : `${name} must be an array of non-empty strings`;
  const checkPositive = (value: unknown, name: string) =>
    value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0)
      ? undefined
      : `${name} must be a positive number`;
  const tools = policy.tools;
  const workspace = policy.workspace;
  const approval = policy.approval;
  const budget = policy.budget;
  const limits = policy.limits;
  const output = policy.output;
  return (
    (workspace?.workingDirectory === undefined ||
    (typeof workspace.workingDirectory === "string" && workspace.workingDirectory.trim().length > 0)
      ? undefined
      : "workspace.workingDirectory must be a non-empty string") ??
    (policy.sandbox === undefined ||
    (typeof policy.sandbox === "string" && policy.sandbox.trim().length > 0)
      ? undefined
      : "sandbox must be a non-empty string") ??
    checkList(tools?.allow, "tools.allow") ??
    checkList(tools?.deny, "tools.deny") ??
    (tools?.network === undefined ||
    ["disabled", "restricted", "unrestricted"].includes(tools.network)
      ? undefined
      : "tools.network must be disabled, restricted, or unrestricted") ??
    checkList(workspace?.writableRoots, "workspace.writableRoots") ??
    checkList(approval?.requiredBefore, "approval.requiredBefore") ??
    checkList(approval?.sideEffectLabels, "approval.sideEffectLabels") ??
    checkPositive(budget?.maxTurns, "budget.maxTurns") ??
    checkPositive(budget?.maxTokens, "budget.maxTokens") ??
    checkPositive(budget?.maxCostUsd, "budget.maxCostUsd") ??
    checkPositive(budget?.timeoutMs, "budget.timeoutMs") ??
    checkPositive(budget?.maxOutputBytes, "budget.maxOutputBytes") ??
    checkPositive(budget?.maxOutputTokens, "budget.maxOutputTokens") ??
    checkPositive(budget?.maxOutputChars, "budget.maxOutputChars") ??
    checkPositive(limits?.maxOutputBytes, "limits.maxOutputBytes") ??
    checkPositive(limits?.maxOutputTokens, "limits.maxOutputTokens") ??
    checkPositive(limits?.maxOutputChars, "limits.maxOutputChars") ??
    checkPositive(output?.maxBytes, "output.maxBytes") ??
    checkPositive(output?.maxTokens, "output.maxTokens") ??
    checkPositive(output?.maxChars, "output.maxChars")
  );
}

/** Bridges the provider-neutral runtime contract to registered local CLI adapters. */
export function createProviderExecutor(options: ProviderExecutorOptions): ProviderExecutor {
  const active = new Map<string, { cancel(): Promise<void> }>();
  // A run can have several attempts in flight at once. Keep the allocator at
  // executor scope so every attempt draws from the same run-level sequence.
  // Map updates are synchronous, so interleaved async event streams cannot
  // receive the same sequence number.
  const nextSequenceByRun = new Map<string, number>();

  const nextSequence = (runId: string): number => {
    const sequence = nextSequenceByRun.get(runId) ?? 0;
    nextSequenceByRun.set(runId, sequence + 1);
    return sequence;
  };

  return {
    async execute(context) {
      const providerId = providerFor(context.node);
      const policyError = validatePolicy(context.policy);
      if (policyError)
        return { status: "failed", error: `Invalid provider policy: ${policyError}` };
      const adapter = options.registry.get(providerId);
      if (!adapter)
        return { status: "failed", error: `Provider '${providerId}' is not registered.` };
      const configuration = context.node.configuration;
      const configured =
        configuration && typeof configuration === "object"
          ? (configuration as Record<string, unknown>)
          : {};
      const metadata: JsonObject = {
        provider: providerId,
        ...(configured.sessionId && typeof configured.sessionId === "string"
          ? { sessionId: configured.sessionId }
          : {}),
        ...(context.policy ? { policy: context.policy as JsonObject } : {}),
      };
      const request = {
        runId: context.runId,
        attemptId: context.attemptId,
        nodeId: context.nodeId,
        input: context.input,
        prompt: promptFor(context.node, context.input),
        cwd: typeof configured.cwd === "string" ? configured.cwd : undefined,
        model: typeof configured.model === "string" ? configured.model : undefined,
        reasoning: typeof configured.reasoning === "string" ? configured.reasoning : undefined,
        metadata,
        ...(context.policy ? { policy: context.policy } : {}),
        signal: context.signal,
      } as Parameters<typeof adapter.start>[0] & { policy?: ProviderPolicy };
      const run = await adapter.start(request);
      active.set(context.attemptId, run);
      const events: TraceEvent[] = [];
      try {
        for await (const event of run.events) {
          const trace = canonicalProviderEvent(
            event,
            context,
            providerId,
            nextSequence(context.runId),
          );
          events.push(trace);
          await options.onEvent?.(trace);
        }
        const session = await run.session;
        const ended = [...events]
          .reverse()
          .find((event) => event.type === "provider.session_ended");
        const endedStatus = ended?.payload.status;
        const cancelled = context.signal.aborted || endedStatus === "cancelled";
        const failed = endedStatus === "failed";
        const terminalSuccess = endedStatus === "succeeded";
        const lastMessage = [...events]
          .reverse()
          .find((event) => event.type === "provider.message");
        const usageEvent = [...events].reverse().find((event) => event.type === "provider.usage");
        const usage = usageEvent?.payload.usage;
        const outputs: JsonObject = {
          provider: providerId,
          sessionId: session.sessionId,
          eventCount: events.length,
          ...(lastMessage?.payload.content !== undefined
            ? { message: lastMessage.payload.content }
            : {}),
          ...(usage && typeof usage === "object" ? { usage: usage as JsonObject } : {}),
        };
        if (cancelled) return { status: "cancelled", outputs, summary: "Provider run cancelled." };
        if (failed)
          return {
            status: "failed",
            outputs,
            error:
              typeof ended?.payload.error === "string"
                ? ended.payload.error
                : "Provider run failed.",
          };
        if (!terminalSuccess)
          return {
            status: "failed",
            outputs,
            error: "Provider run did not provide successful terminal evidence.",
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
