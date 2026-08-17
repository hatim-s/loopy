import type { JsonValue, TraceEvent } from "@loopy/contracts";

/** A deliberately small vocabulary. It is descriptive, not a claim that work is safe to replay. */
export type FeatureClass =
  | "reusable_work"
  | "environment_discovery"
  | "accidental_detour"
  | "one_off"
  | "side_effect";

export type CandidateVariableType = "string" | "number" | "boolean" | "json" | "path" | "directory";

export interface FeatureObservation {
  eventId: string;
  class: FeatureClass;
  confidence: number;
  rationale: string;
  /** The event is evidence for this label; it is never a proof of replayability. */
  evidenceOnly: true;
}

export interface CandidateVariable {
  name: string;
  type: CandidateVariableType;
  confidence: number;
  sourcePaths: string[];
  eventIds: string[];
  /** Values are safe summaries/placeholders, never raw credentials or opaque IDs. */
  observedValues: JsonValue[];
  rationale: string;
}

const SECRET_KEY =
  /(secret|password|passwd|token|api[_ -]?key|authorization|cookie|credential|private[_ -]?key|ssh[_ -]?key)/i;
const PATH_KEY =
  /(^|[._-])(path|file|filename|directory|dir|cwd|workdir|workspace|root)(s)?$|(?:Path|File|Filename|Directory|Dir|Cwd|Workdir|Workspace|Root)(s)?$/i;
const ID_KEY =
  /(^|[._-])(id|uuid|run|node|attempt|session|toolcall)(s)?$|(?:Id|ID|Uuid|UUID|Run|Node|Attempt|Session|ToolCall)(s)?$/i;
const VERSION_KEY = /(^|[._-])version$|Version$/i;
const BRANCH_KEY = /(^|[._-])branch(es)?$|Branch(?:es)?$/i;
const DISCOVERY_TOOL =
  /^(cat|head|tail|ls|find|pwd|which|where|stat|file|git\s+(status|branch|log|diff|show|rev-parse)|env|printenv|uname|node\s+--version|npm\s+--version|bun\s+--version|python\s+--version)$/i;
const SIDE_EFFECT_TOOL =
  /(write|edit|patch|delete|remove|move|rename|mkdir|install|publish|deploy|push|commit|send|post|put|payment|email|message|browser)/i;
const DETOUR_TOOL = /(retry|sleep|wait|debug|diagnos|kill|interrupt|unknown|fallback)/i;

function payloadOf(event: TraceEvent): Record<string, unknown> {
  return event.payload as unknown as Record<string, unknown>;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function eventTool(event: TraceEvent): string | undefined {
  const payload = payloadOf(event);
  return textOf(payload.tool) || undefined;
}

function executionCommand(event: TraceEvent, tool: string | undefined): string | undefined {
  if (
    !tool ||
    !/^(?:exec(?:_command| command)?|shell|bash|sh|zsh|terminal|run(?:_command| command)?|command|execute)$/i.test(
      tool,
    )
  )
    return undefined;
  const input = payloadOf(event).input ?? payloadOf(event).args;
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return undefined;
  const commandKeys = /^(cmd|command|script|arguments?|args)$/i;
  const values: string[] = [];
  const collect = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      if (key && commandKeys.test(key)) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, key);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) collect(child, childKey);
    }
  };
  collect(input);
  return values.length > 0 ? values.join(" ") : undefined;
}

function commandClass(command: string): "environment_discovery" | "side_effect" | undefined {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return undefined;
  // These are bounded, high-signal mutations. An opaque execution tool is not
  // itself a mutation; the structured command must provide the evidence.
  if (
    /\bgit\s+(?:push|commit|reset|checkout|switch|merge|rebase|cherry-pick|clean)\b/.test(
      normalized,
    ) ||
    /(?:^|[;&|]\s*)(?:rm|rmdir|mv|cp|mkdir|touch|install|npm\s+install|pnpm\s+(?:add|install)|yarn\s+add|bun\s+add|terraform\s+apply|kubectl\s+apply)\b/.test(
      normalized,
    ) ||
    /\b(?:sed|perl)\s+[^\n]*\s-i(?:\b|\s)/.test(normalized) ||
    /(?:^|\s)(?:>|>>|tee)\s*/.test(normalized) ||
    /\bcurl\b[^\n]*(?:-X\s*(?:post|put|patch|delete)|--request\s+(?:post|put|patch|delete))\b/.test(
      normalized,
    )
  )
    return "side_effect";
  if (
    /\b(?:pwd|which|where|stat|file|uname)\b/.test(normalized) ||
    /\b(?:ls|find|head|tail|cat)\b/.test(normalized) ||
    /\bgit\s+(?:status|branch|log|diff|show|rev-parse)\b/.test(normalized) ||
    /\b(?:env|printenv|node|npm|bun|python)\s+--version\b/.test(normalized)
  )
    return "environment_discovery";
  return undefined;
}

/** Classify visible, canonical events using only stable event fields and bounded lexical rules. */
export function classifyFeature(event: TraceEvent): FeatureObservation {
  const tool = eventTool(event);
  const type = event.type;
  if (type === "workspace.snapshot_created" || type === "provider.probed") {
    return {
      eventId: event.id,
      class: "environment_discovery",
      confidence: 0.98,
      rationale: `${type} describes the execution environment.`,
      evidenceOnly: true,
    };
  }
  if (
    type === "workspace.file_change_summary" ||
    type === "workspace.diff_created" ||
    type === "artifact.recorded"
  ) {
    return {
      eventId: event.id,
      class: "side_effect",
      confidence: 0.9,
      rationale: `${type} records a workspace or artifact mutation.`,
      evidenceOnly: true,
    };
  }
  if (type === "tool.requested" || type === "tool.started") {
    if (tool && SIDE_EFFECT_TOOL.test(tool))
      return {
        eventId: event.id,
        class: "side_effect",
        confidence: 0.86,
        rationale: `Tool '${tool}' may mutate state or contact an external system.`,
        evidenceOnly: true,
      };
    const command = executionCommand(event, tool);
    const commandClassification = command ? commandClass(command) : undefined;
    if (command && commandClassification === "side_effect")
      return {
        eventId: event.id,
        class: "side_effect",
        confidence: 0.92,
        rationale: `Execution tool '${tool}' carries a structured command with a state-changing operation: '${command}'.`,
        evidenceOnly: true,
      };
    if (command && commandClassification === "environment_discovery")
      return {
        eventId: event.id,
        class: "environment_discovery",
        confidence: 0.9,
        rationale: `Execution tool '${tool}' carries a structured read-only discovery command: '${command}'.`,
        evidenceOnly: true,
      };
    if (tool && DISCOVERY_TOOL.test(tool))
      return {
        eventId: event.id,
        class: "environment_discovery",
        confidence: 0.9,
        rationale: `Tool '${tool}' reads environment or repository state.`,
        evidenceOnly: true,
      };
    if (tool && DETOUR_TOOL.test(tool))
      return {
        eventId: event.id,
        class: "accidental_detour",
        confidence: 0.7,
        rationale: `Tool '${tool}' is commonly used for recovery or diagnosis.`,
        evidenceOnly: true,
      };
    return {
      eventId: event.id,
      class: "reusable_work",
      confidence: 0.62,
      rationale: "Visible tool activity is a candidate operation; replayability needs review.",
      evidenceOnly: true,
    };
  }
  if (
    type === "tool.denied" ||
    type === "attempt.failed" ||
    type === "attempt.cancelled" ||
    type === "node.blocked"
  ) {
    return {
      eventId: event.id,
      class: "accidental_detour",
      confidence: 0.95,
      rationale: `${type} records unsuccessful or blocked work.`,
      evidenceOnly: true,
    };
  }
  if (type === "attempt.retrying" || type === "runtime.recovery") {
    return {
      eventId: event.id,
      class: "accidental_detour",
      confidence: 0.9,
      rationale: `${type} is a recovery transition rather than reusable work.`,
      evidenceOnly: true,
    };
  }
  if (
    type === "verification.started" ||
    type === "verification.result" ||
    type === "node.completed"
  ) {
    return {
      eventId: event.id,
      class: "reusable_work",
      confidence: 0.82,
      rationale: `${type} is part of a repeatable completion or verification contract.`,
      evidenceOnly: true,
    };
  }
  if (type === "provider.message") {
    const content = textOf(payloadOf(event).content);
    if (/^(hi|hello|thanks|thank you|okay|ok)\b/i.test(content.trim())) {
      return {
        eventId: event.id,
        class: "one_off",
        confidence: 0.72,
        rationale: "Short conversational text is not an executable work step.",
        evidenceOnly: true,
      };
    }
    return {
      eventId: event.id,
      class: "reusable_work",
      confidence: 0.58,
      rationale: "Visible provider text is retained as context, not an inferred instruction.",
      evidenceOnly: true,
    };
  }
  if (
    type === "run.created" ||
    type === "run.started" ||
    type === "run.completed" ||
    type === "provider.session_started" ||
    type === "provider.session_ended" ||
    type === "provider.usage"
  ) {
    return {
      eventId: event.id,
      class: "one_off",
      confidence: 0.76,
      rationale: `${type} is lifecycle or accounting metadata.`,
      evidenceOnly: true,
    };
  }
  return {
    eventId: event.id,
    class: "one_off",
    confidence: 0.5,
    rationale: "No deterministic reusable-work rule matched this event.",
    evidenceOnly: true,
  };
}

function safeValue(
  value: unknown,
  key: string,
): { type: CandidateVariableType; observed: JsonValue } | undefined {
  if (SECRET_KEY.test(key)) return undefined;
  if (typeof value === "boolean" && /(enabled|allow|use|flag|verbose)$/i.test(key))
    return { type: "boolean", observed: value };
  if (typeof value === "number" && Number.isFinite(value) && VERSION_KEY.test(key))
    return { type: "number", observed: value };
  if (typeof value === "string") {
    if (ID_KEY.test(key)) return { type: "string", observed: "<id>" };
    if (PATH_KEY.test(key))
      return {
        type: /directory|dir|cwd|workdir|workspace|root/i.test(key) ? "directory" : "path",
        observed: "<path>",
      };
    if (VERSION_KEY.test(key) || BRANCH_KEY.test(key))
      return { type: "string", observed: value.length > 128 ? value.slice(0, 128) : value };
  }
  return undefined;
}

function walk(
  value: unknown,
  path: string,
  event: TraceEvent,
  output: Map<string, CandidateVariable>,
): void {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) walk(child, `${path}[${index}]`, event, output);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const candidate = safeValue(child, key);
      if (candidate) {
        const name = key.replace(/[^A-Za-z0-9]+(.)?/g, (_match, next: string | undefined) =>
          next ? next.toUpperCase() : "",
        );
        if (name && !SECRET_KEY.test(name)) {
          const prior = output.get(name);
          output.set(name, {
            name,
            type: prior?.type ?? candidate.type,
            confidence: Math.max(prior?.confidence ?? 0, candidate.type === "string" ? 0.62 : 0.74),
            sourcePaths: [...new Set([...(prior?.sourcePaths ?? []), childPath])].sort(),
            eventIds: [...new Set([...(prior?.eventIds ?? []), event.id])].sort(),
            observedValues: [...(prior?.observedValues ?? []), candidate.observed]
              .filter(
                (item, index, all) =>
                  all.findIndex((other) => JSON.stringify(other) === JSON.stringify(item)) ===
                  index,
              )
              .slice(0, 5),
            rationale:
              "Candidate inferred from an explicit visible path, version, ID, or branch field; review before exposing it as an input.",
          });
        }
      }
      walk(child, childPath, event, output);
    }
  }
}

/** Infer only typed, redaction-safe input candidates. Raw credentials and opaque IDs are omitted or replaced. */
export function inferCandidateVariables(events: readonly TraceEvent[]): CandidateVariable[] {
  const output = new Map<string, CandidateVariable>();
  for (const event of events) walk(event.payload, "payload", event, output);
  return [...output.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function classifyFeatures(events: readonly TraceEvent[]): FeatureObservation[] {
  return events.map(classifyFeature);
}
