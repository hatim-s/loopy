import { readFile } from "node:fs/promises";
import type {
  JsonObject,
  ProviderCapabilities,
  ProviderInstallation,
  TraceEvent,
} from "@loopy/contracts";
import {
  buildClaudeCapabilities,
  buildClaudeCommand,
  importClaudeHistory,
  parseClaudeJsonLine,
  parseClaudeVersion,
} from "./adapters/claude/index.js";
import {
  buildCodexCapabilities,
  buildCodexCommand,
  importCodexHistory,
  parseCodexJsonLine,
  parseCodexVersion,
} from "./adapters/codex/index.js";
import {
  buildOpenCodeCapabilities,
  buildOpenCodeRunCommand,
  importOpenCodeSession,
  normalizeOpenCodeEvent,
  parseOpenCodeVersion,
} from "./adapters/opencode/index.js";
import {
  buildPiCapabilities,
  buildPiRunCommand,
  importPiSession,
  normalizePiEvent,
  parsePiVersion,
} from "./adapters/pi/index.js";
import {
  type CapabilityReport,
  capabilityReport,
  type HistoricalImportDescriptor,
  normalizeProviderEvent,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderPolicy,
  type ProviderProbe,
  type ProviderRequest,
  type ProviderRun,
} from "./core/index.js";
import { createProviderRegistry } from "./core/registry.js";
import { runSubprocess, startJsonlSubprocess } from "./core/subprocess.js";

export type RegisteredProviderOptions = {
  /** Useful for deterministic CLI shims; production defaults remain provider binaries. */
  executable?: string;
  /** Prefix arguments are argv entries, never a shell string. */
  commandPrefixArgs?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  envAllowlist?: readonly string[];
  version?: string;
};

export type DefaultProviderOptions = Partial<
  Record<"codex" | "claude" | "opencode" | "pi", RegisteredProviderOptions>
>;

const BASE_ENV = ["PATH", "HOME", "USER", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
/** Only the provider's named credential is added; arbitrary process.env is never inherited. */
const DEFAULT_ENV: Record<string, readonly string[]> = {
  codex: [...BASE_ENV, "OPENAI_API_KEY", "CODEX_API_KEY"],
  claude: [...BASE_ENV, "ANTHROPIC_API_KEY"],
  opencode: [...BASE_ENV, "OPENCODE_API_KEY"],
  pi: [...BASE_ENV, "PI_API_KEY"],
};

function cwdFor(options: RegisteredProviderOptions): string {
  return options.cwd ?? process.cwd();
}

function argvFor(
  executable: string,
  prefix: readonly string[] | undefined,
  args: readonly string[],
): readonly [string, ...string[]] {
  return [executable, ...(prefix ?? []), ...args] as [string, ...string[]];
}

function capabilitiesToReport(capabilities: ProviderCapabilities): CapabilityReport {
  const values: Record<
    string,
    { status: "supported" | "degraded" | "unavailable"; reason?: string }
  > = {};
  for (const [key, value] of Object.entries(capabilities)) {
    if (key === "schemaVersion" || key === "provider" || key === "notes") continue;
    if (typeof value !== "boolean") continue;
    values[key] = value
      ? { status: "supported" }
      : { status: "degraded", reason: `${capabilities.provider} does not expose this capability.` };
  }
  return capabilityReport(values);
}

function installationProbe(
  provider: string,
  installation: ProviderInstallation,
  report: CapabilityReport,
): ProviderProbe {
  return {
    provider,
    available: installation.installed,
    ...(installation.executable ? { executable: installation.executable } : {}),
    ...(installation.path ? { path: installation.path } : {}),
    ...(installation.version ? { version: installation.version } : {}),
    capabilities: report,
    ...(installation.diagnostic ? { diagnostic: installation.diagnostic } : {}),
  };
}

function fromTraceEvent(
  event: TraceEvent,
  provider: string,
  request: ProviderRequest,
): ProviderEvent | undefined {
  const payload = event.payload as JsonObject;
  let type: ProviderEvent["type"];
  switch (event.type) {
    case "provider.session_started":
      type = "session_started";
      break;
    case "provider.message":
      type = "message";
      break;
    case "provider.usage":
      type = "usage";
      break;
    case "provider.session_ended":
      type = "session_ended";
      break;
    case "tool.requested":
      type = "tool_call";
      break;
    case "tool.started":
      type = "tool_call";
      break;
    case "tool.completed":
      type = "tool_result";
      break;
    case "tool.denied":
      type = "error";
      break;
    default:
      return undefined;
  }
  return {
    type,
    provider,
    occurredAt: event.occurredAt,
    provenance: {
      runId: request.runId,
      attemptId: request.attemptId,
      nodeId: request.nodeId,
      sessionId: event.sessionId,
      ...(typeof payload.parentSessionId === "string"
        ? { parentSessionId: payload.parentSessionId }
        : {}),
    },
    payload,
    ...(type === "usage" && payload.usage && typeof payload.usage === "object"
      ? { usage: payload.usage as ProviderEvent["usage"] }
      : {}),
  };
}

function fromLineEvent(
  event: {
    kind: string;
    type: string;
    provider: string;
    sessionId?: string;
    parentSessionId?: string;
    parentId?: string;
    toolCallId?: string;
    role?: "assistant" | "user" | "system";
    text?: string;
    tool?: string;
    input?: unknown;
    output?: unknown;
    usage?: ProviderEvent["usage"];
    result?: { status: "succeeded" | "failed" | "cancelled"; summary?: string; error?: string };
    diagnostic?: { code: string; message: string; raw?: string };
    metadata?: JsonObject;
  },
  request: ProviderRequest,
): ProviderEvent {
  const type: ProviderEvent["type"] =
    event.kind === "assistant" || event.kind === "user"
      ? "message"
      : event.kind === "tool"
        ? "tool_call"
        : event.kind === "tool_result"
          ? "tool_result"
          : event.kind === "usage"
            ? "usage"
            : event.kind === "session"
              ? "session_started"
              : event.kind === "result"
                ? "session_ended"
                : event.kind === "subagent_started" || event.kind === "subagent_ended"
                  ? event.kind === "subagent_ended"
                    ? "subagent_ended"
                    : "subagent_started"
                  : "error";
  const payload = {
    ...(event.text ? { content: event.text } : {}),
    ...(event.role ? { role: event.role } : {}),
    ...(event.tool ? { tool: event.tool } : {}),
    ...(event.input !== undefined ? { input: event.input as never } : {}),
    ...(event.output !== undefined ? { output: event.output as never } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    ...(event.result?.status ? { status: event.result.status } : {}),
    ...(event.result?.summary ? { summary: event.result.summary } : {}),
    ...(event.result?.error ? { error: event.result.error } : {}),
    ...(event.diagnostic
      ? {
          diagnostic: {
            code: event.diagnostic.code,
            message: event.diagnostic.message,
            ...(event.diagnostic.raw ? { raw: event.diagnostic.raw } : {}),
          },
        }
      : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  } as unknown as JsonObject;
  return {
    type,
    provider: event.provider,
    occurredAt: new Date().toISOString(),
    provenance: {
      runId: request.runId,
      attemptId: request.attemptId,
      nodeId: request.nodeId,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.parentSessionId ? { parentSessionId: event.parentSessionId } : {}),
      ...(event.parentId ? { subagentId: event.parentId } : {}),
    },
    payload,
    ...(event.usage ? { usage: event.usage } : {}),
  };
}

function importDescriptor(
  id: string,
  formats: readonly string[],
  importer: (source: string, origin: string) => Promise<readonly ProviderEvent[]>,
): HistoricalImportDescriptor {
  return {
    id,
    label: id,
    formats,
    async discover() {
      return [];
    },
    async *import(source) {
      const input =
        source.includes("\n") || source.trim().startsWith("{")
          ? source
          : await readFile(source, "utf8");
      yield* await importer(input, source);
    },
  };
}

type NormalizedLineEvent = ProviderEvent | TraceEvent;

type LineDiagnostic = { code?: string; message: string; rawType?: string };

function policyList(policy: ProviderPolicy | undefined, key: "allow" | "deny"): string[] {
  return [...(policy?.tools?.[key] ?? [])];
}

function assertUnsupportedPolicy(provider: string, checks: Array<[boolean, string]>): void {
  for (const [unsupported, message] of checks) {
    if (unsupported) throw new Error(`${provider} cannot enforce ${message}.`);
  }
}

function errorEvent(
  provider: string,
  request: ProviderRequest,
  message: string,
  sessionId?: string,
  status: "failed" | "cancelled" = "failed",
): ProviderEvent {
  return {
    type: "error",
    provider,
    occurredAt: new Date().toISOString(),
    provenance: {
      runId: request.runId,
      attemptId: request.attemptId,
      nodeId: request.nodeId,
      ...(sessionId ? { sessionId } : {}),
    },
    payload: { status, error: message },
  };
}

function terminalEvent(
  provider: string,
  request: ProviderRequest,
  sessionId: string,
  status: "failed" | "cancelled",
  message: string,
): ProviderEvent {
  return {
    type: "session_ended",
    provider,
    occurredAt: new Date().toISOString(),
    provenance: {
      runId: request.runId,
      attemptId: request.attemptId,
      nodeId: request.nodeId,
      sessionId,
    },
    payload: { status, error: message },
  };
}

function makeAdapter(input: {
  id: "codex" | "claude" | "opencode" | "pi";
  version: string;
  options: RegisteredProviderOptions;
  capabilities: () => CapabilityReport;
  build: (
    request: ProviderRequest,
    options: RegisteredProviderOptions,
  ) => { executable: string; args: readonly string[] };
  normalizeLine: (
    line: string,
    request: ProviderRequest,
  ) => Promise<{ events: NormalizedLineEvent[]; diagnostics?: LineDiagnostic[] }>;
  probeVersion: (output: string) => string | undefined;
  imports: HistoricalImportDescriptor[];
}): ProviderAdapter {
  const options = input.options;
  const report = input.capabilities;
  let observedVersion = options.version;
  return {
    id: input.id,
    version: options.version ?? "unknown",
    capabilities: report,
    async probe() {
      const executable = options.executable ?? input.id;
      try {
        const result = await runSubprocess({
          argv: argvFor(executable, options.commandPrefixArgs, ["--version"]),
          cwd: cwdFor(options),
          env: options.env,
          envAllowlist: options.envAllowlist ?? DEFAULT_ENV[input.id],
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 64 * 1024,
        });
        const version = input.probeVersion(`${result.stdout}\n${result.stderr}`);
        if (version) observedVersion = version;
        return installationProbe(
          input.id,
          {
            schemaVersion: "1",
            provider: input.id,
            installed: result.exitCode === 0 && Boolean(version),
            executable,
            ...(version ? { version } : {}),
            detectedAt: new Date().toISOString(),
            capabilities: {} as ProviderInstallation["capabilities"],
            ...(result.exitCode === 0 && version ? {} : { diagnostic: `${input.id} unavailable.` }),
          },
          report(),
        );
      } catch (error) {
        return {
          provider: input.id,
          available: false,
          executable,
          capabilities: report(),
          diagnostic: `${input.id} unavailable: ${String(error).replace(/[\r\n]+/g, " ")}`,
        };
      }
    },
    async start(request) {
      const controller = new AbortController();
      request.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      const command = input.build(request, options);
      const live = startJsonlSubprocess({
        argv: argvFor(command.executable, options.commandPrefixArgs, command.args),
        cwd: request.cwd ?? cwdFor(options),
        env: options.env,
        envAllowlist: options.envAllowlist ?? DEFAULT_ENV[input.id],
        signal: controller.signal,
        timeoutMs: request.policy?.timeoutMs ?? request.policy?.budget?.timeoutMs,
        maxStdoutBytes: request.policy?.maxOutputBytes,
        maxLineBytes: request.policy?.maxLineBytes,
        maxLines: request.policy?.maxLines,
      });
      let sessionId = request.metadata?.sessionId as string | undefined;
      let resolveSession: (value: {
        provider: string;
        sessionId: string;
        model?: { model?: string; providerVersion?: string };
      }) => void = () => undefined;
      const session = new Promise<{
        provider: string;
        sessionId: string;
        model?: { model?: string; providerVersion?: string };
      }>((resolve) => {
        resolveSession = resolve;
      });
      const run: ProviderRun = {
        session,
        events: (async function* () {
          let terminal = false;
          let malformed = false;
          const convert = (event: NormalizedLineEvent): ProviderEvent | undefined => {
            const converted =
              "provenance" in event
                ? normalizeProviderEvent(event as ProviderEvent, {
                    provider: input.id,
                    provenance: {
                      runId: request.runId,
                      attemptId: request.attemptId,
                      nodeId: request.nodeId,
                    },
                    ...(observedVersion ? { version: observedVersion } : {}),
                  })
                : fromTraceEvent(event as TraceEvent, input.id, request);
            if (!converted) return undefined;
            sessionId ??= converted.provenance.sessionId;
            terminal ||= converted.type === "session_ended";
            return converted;
          };
          try {
            for await (const line of live.lines) {
              const normalized = await input.normalizeLine(line, request);
              for (const diagnostic of normalized.diagnostics ?? []) {
                malformed ||= diagnostic.code === "malformed_event";
                yield errorEvent(input.id, request, diagnostic.message, sessionId);
              }
              for (const event of normalized.events) {
                if ("kind" in event && event.kind === "diagnostic") {
                  malformed ||=
                    (event as { diagnostic?: { code?: string } }).diagnostic?.code ===
                    "malformed_event";
                }
                const converted = convert(event);
                if (converted) yield converted;
              }
            }
            const result = await live.done;
            const finalSessionId = sessionId ?? `${request.attemptId}-session`;
            sessionId = finalSessionId;
            resolveSession({
              provider: input.id,
              sessionId: finalSessionId,
              ...(request.model
                ? {
                    model: {
                      model: request.model,
                      ...(observedVersion ? { providerVersion: observedVersion } : {}),
                    },
                  }
                : {}),
            });
            if (result.aborted) {
              const status = result.timedOut ? "failed" : "cancelled";
              const message = result.diagnostic ?? "Provider process was terminated.";
              yield errorEvent(input.id, request, message, finalSessionId, status);
              yield terminalEvent(input.id, request, finalSessionId, status, message);
            } else if (result.limitExceeded || result.exitCode !== 0) {
              const message = result.diagnostic ?? "Provider process exited unsuccessfully.";
              yield errorEvent(input.id, request, message, finalSessionId);
              yield terminalEvent(input.id, request, finalSessionId, "failed", message);
            } else if (malformed || !terminal) {
              const message = malformed
                ? "Provider emitted malformed JSONL; run failed."
                : "Provider exited without a terminal session event.";
              yield errorEvent(input.id, request, message, finalSessionId);
              yield terminalEvent(input.id, request, finalSessionId, "failed", message);
            }
          } catch (error) {
            const finalSessionId = sessionId ?? `${request.attemptId}-session`;
            resolveSession({ provider: input.id, sessionId: finalSessionId });
            const message = String(error).replace(/[\r\n]+/g, " ");
            yield errorEvent(input.id, request, message, finalSessionId);
            yield terminalEvent(input.id, request, finalSessionId, "failed", message);
          }
        })(),
        cancel: async () => {
          controller.abort();
          await live.cancel();
        },
      };
      return run;
    },
    async cancel(run) {
      await run.cancel();
    },
    historicalImports: input.imports,
    async resume(request) {
      return this.start({
        ...request,
        metadata: { ...(request.metadata ?? {}), sessionId: request.sessionId },
      });
    },
  };
}

export function createCodexProviderAdapter(
  options: RegisteredProviderOptions = {},
): ProviderAdapter {
  return makeAdapter({
    id: "codex",
    version: options.version ?? "unknown",
    options,
    capabilities: () => capabilitiesToReport(buildCodexCapabilities({ version: options.version })),
    build: (request, current) => {
      const policy = request.policy;
      const writableRoots = [...(policy?.workspace?.writableRoots ?? [])];
      const workingDirectory = request.cwd ?? current.cwd;
      assertUnsupportedPolicy("Codex", [
        [
          policyList(policy, "allow").length > 0 || policyList(policy, "deny").length > 0,
          "per-tool allow/deny policy",
        ],
        [policy?.tools?.network !== undefined, "network policy"],
        [
          writableRoots.some((root) => root !== workingDirectory),
          "writable roots outside the working directory",
        ],
        [(policy?.approval?.requiredBefore?.length ?? 0) > 0, "approval checkpoint policy"],
      ]);
      return buildCodexCommand({
        executable: current.executable,
        prompt: request.prompt ?? JSON.stringify(request.input),
        model: request.model,
        cwd: workingDirectory,
        sandbox: writableRoots.length ? "workspace-write" : undefined,
        resumeSessionId: request.metadata?.sessionId as string | undefined,
      });
    },
    normalizeLine: async (line, request) => ({
      events: parseCodexJsonLine(line, {
        sessionId: request.metadata?.sessionId as string | undefined,
      }).map((event) => fromLineEvent(event, request)),
    }),
    probeVersion: parseCodexVersion,
    imports: [
      importDescriptor("codex-jsonl", ["codex-jsonl"], async (source) =>
        importCodexHistory(source, {
          source: "historical-import",
          providerVersion: options.version ?? "unknown",
          importedAt: new Date().toISOString(),
        }).events.map((event) =>
          fromLineEvent(event, {
            runId: "import",
            attemptId: "import",
            nodeId: "import",
            input: {},
          }),
        ),
      ),
    ],
  });
}

export function createClaudeProviderAdapter(
  options: RegisteredProviderOptions = {},
): ProviderAdapter {
  return makeAdapter({
    id: "claude",
    version: options.version ?? "unknown",
    options,
    capabilities: () => capabilitiesToReport(buildClaudeCapabilities({ version: options.version })),
    build: (request, current) => {
      const policy = request.policy;
      assertUnsupportedPolicy("Claude Code", [
        [(policy?.tools?.network ?? undefined) !== undefined, "network policy"],
        [(policy?.workspace?.writableRoots?.length ?? 0) > 0, "writable-root policy"],
      ]);
      const requiredApproval = (policy?.approval?.requiredBefore?.length ?? 0) > 0;
      return buildClaudeCommand({
        executable: current.executable,
        prompt: request.prompt ?? JSON.stringify(request.input),
        model: request.model,
        tools: policyList(policy, "allow").length ? policyList(policy, "allow") : undefined,
        allowedTools: policyList(policy, "allow").length ? policyList(policy, "allow") : undefined,
        disallowedTools: policyList(policy, "deny").length ? policyList(policy, "deny") : undefined,
        permissionMode:
          policy?.approval?.mode === "approve"
            ? "acceptEdits"
            : requiredApproval
              ? "plan"
              : undefined,
        maxTurns: policy?.budget?.maxTurns,
        maxBudgetUsd: policy?.budget?.maxCostUsd,
        sessionId: request.metadata?.sessionId as string | undefined,
      });
    },
    normalizeLine: async (line, request) => ({
      events: parseClaudeJsonLine(line, {
        sessionId: request.metadata?.sessionId as string | undefined,
      }).map((event) => fromLineEvent(event, request)),
    }),
    probeVersion: parseClaudeVersion,
    imports: [
      importDescriptor("claude-stream-json", ["claude-stream-json"], async (source) =>
        importClaudeHistory(source, {
          source: "historical-import",
          providerVersion: options.version ?? "unknown",
          importedAt: new Date().toISOString(),
        }).events.map((event) =>
          fromLineEvent(event, {
            runId: "import",
            attemptId: "import",
            nodeId: "import",
            input: {},
          }),
        ),
      ),
    ],
  });
}

export function createOpenCodeProviderAdapter(
  options: RegisteredProviderOptions = {},
): ProviderAdapter {
  return makeAdapter({
    id: "opencode",
    version: options.version ?? "unknown",
    options,
    capabilities: () => capabilitiesToReport(buildOpenCodeCapabilities(options.version)),
    build: (request, current) => {
      const policy = request.policy;
      assertUnsupportedPolicy("OpenCode", [
        [
          policyList(policy, "allow").length > 0 || policyList(policy, "deny").length > 0,
          "tool allow/deny policy",
        ],
        [policy?.tools?.network !== undefined, "network policy"],
        [(policy?.workspace?.writableRoots?.length ?? 0) > 0, "writable-root policy"],
        [(policy?.approval?.requiredBefore?.length ?? 0) > 0, "approval policy"],
      ]);
      return {
        executable: current.executable ?? "opencode",
        args: buildOpenCodeRunCommand({
          prompt: request.prompt ?? JSON.stringify(request.input),
          model: request.model,
          sessionId: request.metadata?.sessionId as string | undefined,
          dir: request.cwd ?? current.cwd,
          auto: policy?.approval?.mode === "approve",
          allowAuto: policy?.approval?.mode === "approve",
        }).args,
      };
    },
    normalizeLine: async (line, request) => {
      const normalized = normalizeOpenCodeEvent(JSON.parse(line), {
        runId: request.runId,
        nodeId: request.nodeId,
        attemptId: request.attemptId,
        sessionId: request.metadata?.sessionId as string | undefined,
      });
      return {
        events: normalized.event ? [normalized.event] : [],
        diagnostics: normalized.diagnostics,
      };
    },
    probeVersion: parseOpenCodeVersion,
    imports: [
      importDescriptor("opencode-export-v1", ["opencode.export.v1", "run-json"], async (source) => {
        const imported = await importOpenCodeSession(source);
        return imported.events
          .map((event) =>
            fromTraceEvent(event, "opencode", {
              runId: "import",
              attemptId: "import",
              nodeId: "import",
              input: {},
            }),
          )
          .filter((event): event is ProviderEvent => Boolean(event));
      }),
    ],
  });
}

export function createPiProviderAdapter(options: RegisteredProviderOptions = {}): ProviderAdapter {
  return makeAdapter({
    id: "pi",
    version: options.version ?? "unknown",
    options,
    capabilities: () => capabilitiesToReport(buildPiCapabilities(options.version)),
    build: (request, current) => {
      const policy = request.policy;
      assertUnsupportedPolicy("Pi", [
        [
          policy?.tools?.network === "restricted" || policy?.tools?.network === "unrestricted",
          "restricted network policy",
        ],
        [(policy?.workspace?.writableRoots?.length ?? 0) > 0, "writable-root policy"],
      ]);
      return {
        executable: current.executable ?? "pi",
        args: buildPiRunCommand({
          prompt: request.prompt ?? JSON.stringify(request.input),
          model: request.model,
          tools: policyList(policy, "allow").length ? policyList(policy, "allow") : undefined,
          excludeTools: policyList(policy, "deny").length ? policyList(policy, "deny") : undefined,
          approval: policy?.approval?.mode,
          offline: policy?.tools?.network === "disabled",
          sessionId: request.metadata?.sessionId as string | undefined,
          sessionDir: request.cwd ?? current.cwd,
        }).args,
      };
    },
    normalizeLine: async (line, request) => {
      const normalized = normalizePiEvent(JSON.parse(line), {
        runId: request.runId,
        nodeId: request.nodeId,
        attemptId: request.attemptId,
        sessionId: request.metadata?.sessionId as string | undefined,
      });
      return {
        events: normalized.event ? [normalized.event] : [],
        diagnostics: normalized.diagnostics,
      };
    },
    probeVersion: parsePiVersion,
    imports: [
      importDescriptor("pi-session-v3", ["pi.session.v3", "run-json"], async (source, origin) => {
        const imported = await importPiSession(source, {
          source: origin,
          providerVersion: options.version,
        });
        return imported.events
          .map((event) =>
            fromTraceEvent(event, "pi", {
              runId: "import",
              attemptId: "import",
              nodeId: "import",
              input: {},
            }),
          )
          .filter((event): event is ProviderEvent => Boolean(event));
      }),
    ],
  });
}

/** The product default is intentionally all four adapters, even when optional CLIs are absent. */
export function createDefaultProviderRegistry(options: DefaultProviderOptions = {}) {
  return createProviderRegistry([
    createCodexProviderAdapter(options.codex),
    createClaudeProviderAdapter(options.claude),
    createOpenCodeProviderAdapter(options.opencode),
    createPiProviderAdapter(options.pi),
  ]);
}

export const defaultProviderAdapters = [
  createCodexProviderAdapter(),
  createClaudeProviderAdapter(),
  createOpenCodeProviderAdapter(),
  createPiProviderAdapter(),
] as const;
