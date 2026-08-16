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
  normalizeClaudeStream,
  parseClaudeVersion,
} from "./adapters/claude/index.js";
import {
  buildCodexCapabilities,
  buildCodexCommand,
  importCodexHistory,
  normalizeCodexStream,
  parseCodexVersion,
} from "./adapters/codex/index.js";
import {
  buildOpenCodeCapabilities,
  buildOpenCodeRunCommand,
  importOpenCodeSession,
  normalizeOpenCodeJsonLines,
  parseOpenCodeVersion,
} from "./adapters/opencode/index.js";
import {
  buildPiCapabilities,
  buildPiRunCommand,
  importPiSession,
  normalizePiJsonLines,
  parsePiVersion,
} from "./adapters/pi/index.js";
import {
  type CapabilityReport,
  capabilityReport,
  type HistoricalImportDescriptor,
  normalizeProviderEvent,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderProbe,
  type ProviderRequest,
  type ProviderRun,
} from "./core/index.js";
import { createProviderRegistry } from "./core/registry.js";
import { runJsonlSubprocess, runSubprocess } from "./core/subprocess.js";

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

const DEFAULT_ENV = ["PATH", "HOME", "USER", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];

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
                : event.kind === "subagent"
                  ? "subagent_started"
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
  importer: (source: string) => Promise<readonly ProviderEvent[]>,
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
      yield* await importer(input);
    },
  };
}

type NormalizedLineEvent = ProviderEvent | TraceEvent;

function makeAdapter(input: {
  id: "codex" | "claude" | "opencode" | "pi";
  version: string;
  options: RegisteredProviderOptions;
  capabilities: () => CapabilityReport;
  build: (
    request: ProviderRequest,
    options: RegisteredProviderOptions,
  ) => { executable: string; args: readonly string[] };
  normalize: (stdout: string, request: ProviderRequest) => Promise<NormalizedLineEvent[]>;
  probeVersion: (output: string) => string | undefined;
  imports: HistoricalImportDescriptor[];
}): ProviderAdapter {
  const options = input.options;
  const report = input.capabilities;
  return {
    id: input.id,
    version: input.version,
    capabilities: report,
    async probe() {
      const executable = options.executable ?? input.id;
      try {
        const result = await runSubprocess({
          argv: argvFor(executable, options.commandPrefixArgs, ["--version"]),
          cwd: cwdFor(options),
          env: options.env,
          envAllowlist: options.envAllowlist ?? DEFAULT_ENV,
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 64 * 1024,
        });
        const version = input.probeVersion(`${result.stdout}\n${result.stderr}`);
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
      const result = await runJsonlSubprocess({
        argv: argvFor(command.executable, options.commandPrefixArgs, command.args),
        cwd: request.cwd ?? cwdFor(options),
        env: options.env,
        envAllowlist: options.envAllowlist ?? DEFAULT_ENV,
        signal: controller.signal,
      });
      const normalized = await input.normalize(result.stdout, request);
      const events = normalized
        .map((event) =>
          "provenance" in event
            ? normalizeProviderEvent(event as ProviderEvent, {
                provider: input.id,
                provenance: {
                  runId: request.runId,
                  attemptId: request.attemptId,
                  nodeId: request.nodeId,
                },
                version: input.version,
              })
            : fromTraceEvent(event as TraceEvent, input.id, request),
        )
        .filter((event): event is ProviderEvent => Boolean(event));
      return {
        session: Promise.resolve({
          provider: input.id,
          sessionId:
            events.find((event) => event.provenance.sessionId)?.provenance.sessionId ??
            `${request.attemptId}-session`,
          ...(request.model ? { model: { model: request.model } } : {}),
        }),
        events: (async function* () {
          yield* events;
        })(),
        cancel: async () => controller.abort(),
      } satisfies ProviderRun;
    },
    async cancel(run) {
      await run.cancel();
    },
    historicalImports: input.imports,
  };
}

export function createCodexProviderAdapter(
  options: RegisteredProviderOptions = {},
): ProviderAdapter {
  return makeAdapter({
    id: "codex",
    version: "codex-cli-0.146.0",
    options,
    capabilities: () => capabilitiesToReport(buildCodexCapabilities({ version: options.version })),
    build: (request, current) =>
      buildCodexCommand({
        executable: current.executable,
        prompt: request.prompt ?? JSON.stringify(request.input),
        model: request.model,
        cwd: request.cwd ?? current.cwd,
        resumeSessionId: request.metadata?.sessionId as string | undefined,
      }),
    normalize: async (stdout, request) =>
      normalizeCodexStream(stdout, {
        sessionId: request.metadata?.sessionId as string | undefined,
      }).map((event) => fromLineEvent(event, request)),
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
    version: "claude-code-1.0.0",
    options,
    capabilities: () => capabilitiesToReport(buildClaudeCapabilities({ version: options.version })),
    build: (request, current) =>
      buildClaudeCommand({
        executable: current.executable,
        prompt: request.prompt ?? JSON.stringify(request.input),
        model: request.model,
        sessionId: request.metadata?.sessionId as string | undefined,
      }),
    normalize: async (stdout, request) =>
      normalizeClaudeStream(stdout, {
        sessionId: request.metadata?.sessionId as string | undefined,
      }).map((event) => fromLineEvent(event, request)),
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
    version: "opencode-1.0.0",
    options,
    capabilities: () => capabilitiesToReport(buildOpenCodeCapabilities(options.version)),
    build: (request, current) => ({
      executable: current.executable ?? "opencode",
      args: buildOpenCodeRunCommand({
        prompt: request.prompt ?? JSON.stringify(request.input),
        model: request.model,
        sessionId: request.metadata?.sessionId as string | undefined,
        dir: request.cwd ?? current.cwd,
      }).args,
    }),
    normalize: async (stdout, request) =>
      (
        await normalizeOpenCodeJsonLines(stdout.split(/\r?\n/), {
          runId: request.runId,
          nodeId: request.nodeId,
          attemptId: request.attemptId,
          sessionId: request.metadata?.sessionId as string | undefined,
        })
      ).events,
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
    version: "pi-1.0.0",
    options,
    capabilities: () => capabilitiesToReport(buildPiCapabilities(options.version)),
    build: (request, current) => ({
      executable: current.executable ?? "pi",
      args: buildPiRunCommand({
        prompt: request.prompt ?? JSON.stringify(request.input),
        model: request.model,
        sessionId: request.metadata?.sessionId as string | undefined,
        sessionDir: request.cwd ?? current.cwd,
      }).args,
    }),
    normalize: async (stdout, request) =>
      (
        await normalizePiJsonLines(stdout.split(/\r?\n/), {
          runId: request.runId,
          nodeId: request.nodeId,
          attemptId: request.attemptId,
          sessionId: request.metadata?.sessionId as string | undefined,
        })
      ).events,
    probeVersion: parsePiVersion,
    imports: [
      importDescriptor("pi-session-v3", ["pi.session.v3", "run-json"], async (source) => {
        const imported = await importPiSession(source);
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
