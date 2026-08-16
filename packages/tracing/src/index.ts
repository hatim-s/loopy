import { type JsonValue, SupportedTraceEventSchema, type TraceEvent } from "@loopy/contracts";

/** The interchange format deliberately contains only TraceEvent JSON objects. */
export const TRACE_JSONL_FORMAT = "loopy.trace.jsonl" as const;
export const TRACE_JSONL_FORMAT_VERSION = 1 as const;
export type RunEvent = TraceEvent;

export interface TraceLimits {
  maxBytes: number;
  maxLines: number;
  maxEvents: number;
}

export const DEFAULT_TRACE_LIMITS: Readonly<TraceLimits> = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxLines: 100_000,
  maxEvents: 100_000,
});

export type TraceDiagnosticCode =
  | "invalid_event"
  | "unsupported_schema_version"
  | "malformed_json"
  | "truncated_line"
  | "invalid_utf8"
  | "duplicate_sequence"
  | "sequence_gap"
  | "out_of_order"
  | "missing_trailing_newline"
  | "unexpected_trailing_newline"
  | "max_bytes_exceeded"
  | "max_lines_exceeded"
  | "max_events_exceeded"
  | "hidden_chain_of_thought";

export interface TraceDiagnostic {
  code: TraceDiagnosticCode;
  message: string;
  line?: number;
  inputIndex?: number;
  sequence?: number;
  expectedSequence?: number;
  actualSequence?: number;
  path?: string;
}

export class TraceCodecError extends Error {
  readonly diagnostics: readonly TraceDiagnostic[];

  constructor(message: string, diagnostics: readonly TraceDiagnostic[]) {
    super(message);
    this.name = "TraceCodecError";
    this.diagnostics = diagnostics;
  }
}

export type TraceEventInput = Iterable<TraceEvent> | AsyncIterable<TraceEvent>;

/** Event-oriented seams let a SQLite-backed source/sink share this codec without dual writes. */
export interface TraceEventSource {
  events(): TraceEventInput;
}

export type TraceSource = TraceEventSource;

export interface TraceEventSink {
  append(event: TraceEvent): void | Promise<void>;
}

export type TraceSink = TraceEventSink;

export interface TraceByteSink {
  write(chunk: Uint8Array): void | Promise<void>;
  close?(): void | Promise<void>;
}

export function traceEventSource(events: TraceEventInput): TraceEventSource {
  return { events: () => events };
}

export interface RedactionRecord {
  eventId: string;
  sequence: number;
  category: "message" | "tool" | "artifact" | "custom";
  field: string;
  action: "replace" | "remove";
}

export interface RedactionPolicy {
  /** Redacts the category's safe defaults, or the supplied event-relative paths. */
  message?: boolean | readonly string[];
  tool?: boolean | readonly string[];
  artifact?: boolean | readonly string[];
  /** Additional event-relative paths. Exact paths only; no wildcard or hidden reasoning support. */
  fields?: readonly string[];
  replacement?: string;
}

const DEFAULT_REDACTION_FIELDS: Record<RedactionRecord["category"], readonly string[]> = {
  message: ["payload.content", "payload.message"],
  tool: ["payload.input", "payload.output", "payload.tool", "payload.reason"],
  artifact: [
    "payload.artifact.sourcePath",
    "payload.artifact.mediaType",
    "payload.artifact.producerNodeId",
  ],
  custom: [],
};
const HIDDEN_REASONING_KEY = /hidden[_ -]?chain|chain[_ -]?of[_ -]?thought|reasoning[_ -]?content/i;

function diagnosticMessage(diagnostic: TraceDiagnostic): string {
  const location = diagnostic.line === undefined ? "" : ` at line ${diagnostic.line}`;
  return `${diagnostic.message}${location}`;
}

function failIfRequested(
  diagnostics: TraceDiagnostic[],
  options: { rejectDiagnostics?: boolean },
): void {
  if (options.rejectDiagnostics === true && diagnostics.length > 0) {
    throw new TraceCodecError(diagnosticMessage(diagnostics[0] as TraceDiagnostic), diagnostics);
  }
}

function limitsFor(options: TraceCodecOptions): TraceLimits {
  const limits = {
    ...DEFAULT_TRACE_LIMITS,
    ...options.limits,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }),
    ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents }),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Trace limit ${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function scanForHiddenReasoning(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = scanForHiddenReasoning(child, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (HIDDEN_REASONING_KEY.test(key)) return childPath;
      const found = scanForHiddenReasoning(child, childPath);
      if (found) return found;
    }
  }
  return undefined;
}

function parseEvent(
  value: unknown,
  location: Pick<TraceDiagnostic, "line" | "inputIndex">,
): TraceEvent {
  const hiddenPath = scanForHiddenReasoning(value);
  if (hiddenPath) {
    throw new TraceCodecError("Hidden chain-of-thought fields are not a trace contract.", [
      {
        code: "hidden_chain_of_thought",
        message: "Hidden chain-of-thought fields are not supported.",
        ...location,
        path: hiddenPath,
      },
    ]);
  }
  const result = SupportedTraceEventSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const suppliedVersion =
      typeof value === "object" && value !== null && "schemaVersion" in value
        ? (value as { schemaVersion?: unknown }).schemaVersion
        : undefined;
    throw new TraceCodecError("Trace event failed schema validation.", [
      {
        code:
          suppliedVersion !== undefined && suppliedVersion !== "1"
            ? "unsupported_schema_version"
            : "invalid_event",
        message: issue?.message ?? "Trace event failed schema validation.",
        ...location,
        path: issue?.path.join("."),
      },
    ]);
  }
  return result.data;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((child) => cloneJson(child));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
  }
  return value;
}

function setPath(root: Record<string, unknown>, path: string, replacement: string): boolean {
  const parts = path.split(".");
  let current: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (current === null || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[part];
  }
  if (current === null || typeof current !== "object") return false;
  const leaf = parts.at(-1);
  if (!leaf || !(leaf in (current as Record<string, unknown>))) return false;
  (current as Record<string, unknown>)[leaf] = replacement;
  return true;
}

function removePath(root: Record<string, unknown>, path: string): boolean {
  const parts = path.split(".");
  let current: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (current === null || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[part];
  }
  if (current === null || typeof current !== "object") return false;
  const leaf = parts.at(-1);
  if (!leaf || !(leaf in (current as Record<string, unknown>))) return false;
  delete (current as Record<string, unknown>)[leaf];
  return true;
}

const REMOVABLE_REDACTION_FIELDS = new Set(["payload.artifact.producerNodeId"]);

function categoryForPath(path: string, policy: RedactionPolicy): RedactionRecord["category"] {
  for (const category of ["message", "tool", "artifact"] as const) {
    const configured = policy[category];
    const fields = Array.isArray(configured)
      ? configured
      : configured
        ? DEFAULT_REDACTION_FIELDS[category]
        : [];
    if (fields.includes(path)) return category;
    if (DEFAULT_REDACTION_FIELDS[category].includes(path)) return category;
  }
  return "custom";
}

function recordsFromRedaction(event: TraceEvent): RedactionRecord[] {
  return event.redaction.removedFields.map((field) => ({
    eventId: event.id,
    sequence: event.sequence,
    category: categoryForPath(field, {}),
    field,
    action: REMOVABLE_REDACTION_FIELDS.has(field) ? "remove" : "replace",
  }));
}

function pathsForPolicy(policy: RedactionPolicy): readonly string[] {
  const fields = new Set<string>(policy.fields ?? []);
  for (const category of ["message", "tool", "artifact"] as const) {
    const configured = policy[category];
    if (Array.isArray(configured)) {
      for (const path of configured) fields.add(path);
    } else if (configured) {
      for (const path of DEFAULT_REDACTION_FIELDS[category]) fields.add(path);
    }
  }
  return [...fields].sort();
}

export interface RedactedTraceEvent {
  event: TraceEvent;
  records: readonly RedactionRecord[];
}

export function redactTraceEvent(event: TraceEvent, policy: RedactionPolicy): RedactedTraceEvent {
  const paths = pathsForPolicy(policy);
  const hiddenPath = paths.find((path) => HIDDEN_REASONING_KEY.test(path));
  if (hiddenPath) {
    throw new TraceCodecError("Hidden chain-of-thought fields are not supported.", [
      {
        code: "hidden_chain_of_thought",
        message: "Redaction cannot target hidden chain-of-thought fields.",
        sequence: event.sequence,
        path: hiddenPath,
      },
    ]);
  }
  if (paths.length === 0) return { event, records: [] };
  const copy = cloneJson(event) as Record<string, unknown>;
  const replacement = policy.replacement ?? "[REDACTED]";
  const records: RedactionRecord[] = [];
  for (const path of paths) {
    const action = REMOVABLE_REDACTION_FIELDS.has(path) ? "remove" : "replace";
    const changed = action === "remove" ? removePath(copy, path) : setPath(copy, path, replacement);
    if (!changed) continue;
    records.push({
      eventId: event.id,
      sequence: event.sequence,
      category: categoryForPath(path, policy),
      field: path,
      action,
    });
  }
  if (records.length === 0) return { event, records };
  if (records.some((record) => record.category === "artifact")) {
    const artifact = (copy.payload as Record<string, unknown> | undefined)?.artifact;
    if (artifact !== null && typeof artifact === "object") {
      (artifact as Record<string, unknown>).redacted = true;
    }
  }
  const existing = event.redaction;
  copy.redaction = {
    status: existing.status === "full" ? "full" : "partial",
    removedFields: [
      ...new Set([...existing.removedFields, ...records.map((record) => record.field)]),
    ].sort(),
  };
  return { event: parseEvent(copy, { inputIndex: 0 }), records };
}

export interface TraceCodecOptions {
  limits?: Partial<TraceLimits>;
  redaction?: RedactionPolicy;
  /** Output always uses LF. The default includes exactly one final LF for non-empty exports. */
  trailingNewline?: boolean | "required" | "optional" | "forbidden";
  /** Top-level aliases are convenient for callers configuring one limit. */
  maxBytes?: number;
  maxLines?: number;
  maxEvents?: number;
  /** Reject schema and safety diagnostics. Ordering diagnostics remain non-fatal unless requested. */
  rejectDiagnostics?: boolean;
  trailingNewlinePolicy?: "required" | "optional" | "forbidden";
}

export interface NormalizedTrace {
  events: readonly TraceEvent[];
  diagnostics: readonly TraceDiagnostic[];
  redactions: readonly RedactionRecord[];
}

function orderingDiagnostics(
  events: readonly TraceEvent[],
  sourceIndices: readonly number[],
  inputOrderEvents: readonly TraceEvent[] = events,
  inputOrderIndices: readonly number[] = sourceIndices,
): TraceDiagnostic[] {
  const diagnostics: TraceDiagnostic[] = [];
  const seen = new Set<number>();
  let previous: number | undefined;
  for (const [index, event] of events.entries()) {
    const sourceIndex = sourceIndices[index];
    if (seen.has(event.sequence)) {
      diagnostics.push({
        code: "duplicate_sequence",
        message: `Duplicate trace sequence ${event.sequence}.`,
        inputIndex: sourceIndex,
        sequence: event.sequence,
      });
    }
    seen.add(event.sequence);
    if (previous !== undefined && event.sequence > previous + 1) {
      diagnostics.push({
        code: "sequence_gap",
        message: `Trace sequence gap: expected ${previous + 1}, received ${event.sequence}.`,
        inputIndex: sourceIndex,
        expectedSequence: previous + 1,
        actualSequence: event.sequence,
      });
    }
    previous = event.sequence;
  }
  if (events.length > 0 && events[0]?.sequence !== 0) {
    diagnostics.push({
      code: "sequence_gap",
      message: `Trace sequence must start at 0, received ${events[0]?.sequence ?? "none"}.`,
      inputIndex: sourceIndices[0],
      expectedSequence: 0,
      actualSequence: events[0]?.sequence,
    });
  }
  let previousInputSequence: number | undefined;
  for (const [index, event] of inputOrderEvents.entries()) {
    const sourceIndex = inputOrderIndices[index];
    if (previousInputSequence !== undefined && event.sequence < previousInputSequence) {
      diagnostics.push({
        code: "out_of_order",
        message: `Trace sequence ${event.sequence} arrived after ${previousInputSequence}.`,
        inputIndex: sourceIndex,
        sequence: event.sequence,
      });
    }
    previousInputSequence = event.sequence;
  }
  return diagnostics;
}

function normalizeSync(
  events: Iterable<TraceEvent>,
  options: TraceCodecOptions = {},
): NormalizedTrace {
  const limits = limitsFor(options);
  const collected: Array<{ event: TraceEvent; sourceIndex: number }> = [];
  const redactions: RedactionRecord[] = [];
  const diagnostics: TraceDiagnostic[] = [];
  let inputIndex = 0;
  for (const value of events) {
    if (inputIndex >= limits.maxEvents) {
      throw new TraceCodecError("Trace event limit exceeded.", [
        {
          code: "max_events_exceeded",
          message: `Maximum events is ${limits.maxEvents}.`,
          inputIndex,
        },
      ]);
    }
    let event: TraceEvent;
    try {
      event = parseEvent(value, { inputIndex });
    } catch (error) {
      if (options.rejectDiagnostics === false && error instanceof TraceCodecError) {
        // Tolerant validation drops the invalid event, but never drops the
        // evidence that it was dropped.
        diagnostics.push(...error.diagnostics);
        inputIndex += 1;
        continue;
      }
      throw error;
    }
    if (options.redaction) {
      try {
        const redacted = redactTraceEvent(event, options.redaction);
        event = redacted.event;
        redactions.push(...redacted.records);
      } catch (error) {
        if (options.rejectDiagnostics === false && error instanceof TraceCodecError) {
          diagnostics.push(...error.diagnostics);
          inputIndex += 1;
          continue;
        }
        throw error;
      }
    }
    collected.push({ event, sourceIndex: inputIndex });
    inputIndex += 1;
  }
  const sorted = [...collected].sort((left, right) => left.event.sequence - right.event.sequence);
  diagnostics.push(
    ...orderingDiagnostics(
      sorted.map((entry) => entry.event),
      sorted.map((entry) => entry.sourceIndex),
      collected.map((entry) => entry.event),
      collected.map((entry) => entry.sourceIndex),
    ),
  );
  failIfRequested(diagnostics, options);
  return { events: sorted.map((entry) => entry.event), diagnostics, redactions };
}

export function normalizeTraceEvents(
  events: Iterable<TraceEvent>,
  options: TraceCodecOptions = {},
): NormalizedTrace {
  return normalizeSync(events, options);
}

async function normalizeAsync(
  source: TraceEventInput | TraceEventSource,
  options: TraceCodecOptions = {},
): Promise<NormalizedTrace> {
  const events =
    "events" in source && typeof source.events === "function" ? source.events() : source;
  if (Symbol.asyncIterator in Object(events)) {
    const limits = limitsFor(options);
    const collected: TraceEvent[] = [];
    for await (const event of events as AsyncIterable<TraceEvent>) {
      if (collected.length >= limits.maxEvents) {
        throw new TraceCodecError("Trace event limit exceeded.", [
          {
            code: "max_events_exceeded",
            message: `Maximum events is ${limits.maxEvents}.`,
            inputIndex: collected.length,
          },
        ]);
      }
      collected.push(event);
    }
    return normalizeSync(collected, options);
  }
  return normalizeSync(events as Iterable<TraceEvent>, options);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((child) => canonicalize(child));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

function renderEvents(
  events: readonly TraceEvent[],
  options: TraceCodecOptions,
): { text: string; bytes: number; lines: number } {
  const trailingNewline =
    options.trailingNewline === undefined ||
    options.trailingNewline === true ||
    options.trailingNewline === "required";
  const lines = events.map((event) => canonicalJson(event as unknown as JsonValue));
  const text = lines.join("\n") + (trailingNewline && lines.length > 0 ? "\n" : "");
  const bytes = new TextEncoder().encode(text).byteLength;
  const limits = limitsFor(options);
  if (bytes > limits.maxBytes) {
    throw new TraceCodecError("Trace byte limit exceeded.", [
      { code: "max_bytes_exceeded", message: `Maximum bytes is ${limits.maxBytes}.` },
    ]);
  }
  if (lines.length > limits.maxLines) {
    throw new TraceCodecError("Trace line limit exceeded.", [
      { code: "max_lines_exceeded", message: `Maximum lines is ${limits.maxLines}.` },
    ]);
  }
  return { text, bytes, lines: lines.length };
}

export interface TraceJsonlExport {
  text: string;
  events: readonly TraceEvent[];
  diagnostics: readonly TraceDiagnostic[];
  redactions: readonly RedactionRecord[];
  bytes: number;
  lines: number;
}

export function encodeTraceJsonl(
  events: Iterable<TraceEvent>,
  options: TraceCodecOptions = {},
): string {
  return encodeTraceJsonlReport(events, options).text;
}

export function encodeTraceJsonlReport(
  events: Iterable<TraceEvent>,
  options: TraceCodecOptions = {},
): TraceJsonlExport {
  const normalized = normalizeSync(events, options);
  const rendered = renderEvents(normalized.events, options);
  return { ...rendered, ...normalized };
}

export async function encodeTraceJsonlAsync(
  source: TraceEventInput | TraceEventSource,
  options: TraceCodecOptions = {},
): Promise<string> {
  const normalized = await normalizeAsync(source, options);
  return renderEvents(normalized.events, options).text;
}

export async function* encodeTraceJsonlStream(
  source: TraceEventInput | TraceEventSource,
  options: TraceCodecOptions = {},
): AsyncGenerator<Uint8Array> {
  const normalized = await normalizeAsync(source, options);
  const limits = limitsFor(options);
  const trailingNewline =
    options.trailingNewline === undefined ||
    options.trailingNewline === true ||
    options.trailingNewline === "required";
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const [index, event] of normalized.events.entries()) {
    const isLast = index === normalized.events.length - 1;
    const line = `${canonicalJson(event as unknown as JsonValue)}${!isLast || trailingNewline ? "\n" : ""}`;
    const chunk = encoder.encode(line);
    bytes += chunk.byteLength;
    if (bytes > limits.maxBytes) {
      throw new TraceCodecError("Trace byte limit exceeded.", [
        { code: "max_bytes_exceeded", message: `Maximum bytes is ${limits.maxBytes}.` },
      ]);
    }
    if (index + 1 > limits.maxLines) {
      throw new TraceCodecError("Trace line limit exceeded.", [
        { code: "max_lines_exceeded", message: `Maximum lines is ${limits.maxLines}.` },
      ]);
    }
    yield chunk;
  }
}

export async function writeTraceJsonl(
  source: TraceEventInput | TraceEventSource,
  sink: TraceByteSink,
  options: TraceCodecOptions = {},
): Promise<TraceJsonlExport> {
  const normalized = await normalizeAsync(source, options);
  const rendered = renderEvents(normalized.events, options);
  const encoder = new TextEncoder();
  for (const line of rendered.text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    await sink.write(encoder.encode(line));
  }
  await sink.close?.();
  return { ...rendered, ...normalized };
}

export interface TraceJsonlImport {
  events: readonly TraceEvent[];
  diagnostics: readonly TraceDiagnostic[];
  bytes: number;
  lines: number;
  redactions: readonly RedactionRecord[];
}

function trailingPolicy(options: TraceCodecOptions): "required" | "optional" | "forbidden" {
  return (
    options.trailingNewlinePolicy ??
    (typeof options.trailingNewline === "string" ? options.trailingNewline : "optional")
  );
}

function decodeText(
  text: string,
  byteLength: number,
  options: TraceCodecOptions,
): TraceJsonlImport {
  const limits = limitsFor(options);
  if (byteLength > limits.maxBytes) {
    throw new TraceCodecError("Trace byte limit exceeded.", [
      { code: "max_bytes_exceeded", message: `Maximum bytes is ${limits.maxBytes}.` },
    ]);
  }
  const hasTrailingNewline = text.endsWith("\n");
  const policy = trailingPolicy(options);
  const diagnostics: TraceDiagnostic[] = [];
  if (policy === "required" && text.length > 0 && !hasTrailingNewline) {
    diagnostics.push({ code: "missing_trailing_newline", message: "Trace must end with LF." });
  }
  if (policy === "forbidden" && hasTrailingNewline) {
    diagnostics.push({
      code: "unexpected_trailing_newline",
      message: "Trace must not end with LF.",
    });
  }
  if (options.rejectDiagnostics !== false && diagnostics.length > 0) {
    throw new TraceCodecError(
      diagnostics[0]?.message ?? "Invalid JSONL trailing-newline policy.",
      diagnostics,
    );
  }
  const body = hasTrailingNewline ? text.slice(0, -1) : text;
  const rawLines = body.length === 0 ? [] : body.split("\n");
  if (rawLines.length > limits.maxLines) {
    throw new TraceCodecError("Trace line limit exceeded.", [
      { code: "max_lines_exceeded", message: `Maximum lines is ${limits.maxLines}.` },
    ]);
  }
  const parsed: Array<{ event: TraceEvent; inputIndex: number }> = [];
  const redactions: RedactionRecord[] = [];
  for (const [lineIndex, line] of rawLines.entries()) {
    if (line.trim().length === 0) {
      const diagnostic: TraceDiagnostic = {
        code: "malformed_json",
        message: "Blank JSONL lines are not events.",
        line: lineIndex + 1,
      };
      if (options.rejectDiagnostics === false) diagnostics.push(diagnostic);
      else throw new TraceCodecError(diagnostic.message, [diagnostic]);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      const diagnostic: TraceDiagnostic = {
        code:
          lineIndex === rawLines.length - 1 && !hasTrailingNewline
            ? "truncated_line"
            : "malformed_json",
        message: "Trace line is not valid JSON.",
        line: lineIndex + 1,
      };
      if (options.rejectDiagnostics === false) diagnostics.push(diagnostic);
      else throw new TraceCodecError(diagnostic.message, [diagnostic]);
      continue;
    }
    try {
      const event = parseEvent(value, { line: lineIndex + 1, inputIndex: lineIndex });
      parsed.push({ event, inputIndex: lineIndex });
      redactions.push(...recordsFromRedaction(event));
    } catch (error) {
      if (options.rejectDiagnostics === false && error instanceof TraceCodecError) {
        diagnostics.push(...error.diagnostics);
      } else {
        throw error;
      }
    }
    if (parsed.length > limits.maxEvents) {
      throw new TraceCodecError("Trace event limit exceeded.", [
        {
          code: "max_events_exceeded",
          message: `Maximum events is ${limits.maxEvents}.`,
          line: lineIndex + 1,
        },
      ]);
    }
  }
  const sorted = [...parsed].sort((left, right) => left.event.sequence - right.event.sequence);
  diagnostics.push(
    ...orderingDiagnostics(
      sorted.map((entry) => entry.event),
      sorted.map((entry) => entry.inputIndex),
      parsed.map((entry) => entry.event),
      parsed.map((entry) => entry.inputIndex),
    ).map((diagnostic) => ({
      ...diagnostic,
      line: diagnostic.inputIndex === undefined ? undefined : diagnostic.inputIndex + 1,
    })),
  );
  failIfRequested(diagnostics, options);
  return {
    events: sorted.map((entry) => entry.event),
    diagnostics,
    bytes: byteLength,
    lines: rawLines.length,
    redactions,
  };
}

export function decodeTraceJsonl(
  input: string | Uint8Array,
  options: TraceCodecOptions = {},
): TraceJsonlImport {
  if (typeof input === "string") {
    const encoded = new TextEncoder().encode(input);
    return decodeText(input, encoded.byteLength, options);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    return decodeText(text, input.byteLength, options);
  } catch (error) {
    if (error instanceof TraceCodecError) throw error;
    throw new TraceCodecError("Trace is not valid UTF-8.", [
      { code: "invalid_utf8", message: "Trace bytes are not valid UTF-8." },
    ]);
  }
}

export async function decodeTraceJsonlStream(
  chunks: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>,
  options: TraceCodecOptions = {},
): Promise<TraceJsonlImport> {
  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  try {
    for await (const chunk of chunks) {
      if (typeof chunk === "string") {
        const encoded = new TextEncoder().encode(chunk);
        bytes += encoded.byteLength;
        parts.push(chunk);
      } else {
        bytes += chunk.byteLength;
        parts.push(textDecoder.decode(chunk, { stream: true }));
      }
      if (bytes > limitsFor(options).maxBytes) {
        throw new TraceCodecError("Trace byte limit exceeded.", [
          {
            code: "max_bytes_exceeded",
            message: `Maximum bytes is ${limitsFor(options).maxBytes}.`,
          },
        ]);
      }
    }
    parts.push(textDecoder.decode());
  } catch (error) {
    if (error instanceof TraceCodecError) throw error;
    throw new TraceCodecError("Trace is not valid UTF-8.", [
      { code: "invalid_utf8", message: "Trace bytes are not valid UTF-8." },
    ]);
  }
  return decodeText(parts.join(""), bytes, options);
}

export async function importTraceJsonl(
  input: string | Uint8Array | AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>,
  sink: TraceEventSink,
  options: TraceCodecOptions = {},
): Promise<TraceJsonlImport> {
  const decoded =
    typeof input === "string" || input instanceof Uint8Array
      ? decodeTraceJsonl(input, options)
      : await decodeTraceJsonlStream(input, options);
  for (const event of decoded.events) await sink.append(event);
  return decoded;
}

/** Compatibility aliases for callers that use serialize/deserialize vocabulary. */
export const serializeTraceJsonl = encodeTraceJsonl;
export const deserializeTraceJsonl = decodeTraceJsonl;
