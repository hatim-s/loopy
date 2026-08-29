import { type TraceEvent, TraceEventSchema } from "@loopy/contracts";
import { describe, expect, test } from "vitest";
import {
  decodeTraceJsonl,
  decodeTraceJsonlStream,
  encodeTraceJsonl,
  encodeTraceJsonlReport,
  encodeTraceJsonlStream,
  importTraceJsonl,
  normalizeTraceEvents,
  redactTraceEvent,
  TraceCodecError,
  type TraceEventSink,
} from "../src/index.js";

const fixtureText = await Bun.file(new URL("../fixtures/trace.jsonl", import.meta.url)).text();
const fixture = decodeTraceJsonl(fixtureText, { trailingNewlinePolicy: "required" });
const events = fixture.events as TraceEvent[];

function expectCodecError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected TraceCodecError");
  } catch (error) {
    expect(error).toBeInstanceOf(TraceCodecError);
    expect((error as TraceCodecError).diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      code,
    );
  }
}

describe("trace JSONL codec", () => {
  test("round-trips the golden fixture byte-for-byte", () => {
    expect(encodeTraceJsonl(events, { trailingNewline: true })).toBe(fixtureText);
    expect(decodeTraceJsonl(fixtureText, { trailingNewlinePolicy: "required" }).events).toEqual(
      events,
    );
  });

  test("sorts by sequence and emits canonical keys with a final LF", () => {
    const report = encodeTraceJsonlReport([...events].reverse());
    expect(report.events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain("out_of_order");
    expect(report.text.endsWith("\n")).toBe(true);
    expect(report.text).toBe(fixtureText);
    expect(report.text.split("\n")[0]?.startsWith('{"id"')).toBe(true);
  });

  test("reports duplicate and gap sequences without losing deterministic order", () => {
    const sequenceTwo = { ...events[1], sequence: 2 } as TraceEvent;
    const report = normalizeTraceEvents([
      events[0] as TraceEvent,
      events[0] as TraceEvent,
      sequenceTwo,
    ]);
    expect(report.events.map((event) => event.sequence)).toEqual([0, 0, 2]);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["duplicate_sequence", "sequence_gap"]),
    );
  });

  test("reports every dropped invalid or safety event in tolerant normalization", () => {
    const invalid = { ...events[0], payload: { workflowVersion: 1 } } as TraceEvent;
    const unsupported = { ...events[0], schemaVersion: "99" } as unknown as TraceEvent;
    const hidden = {
      ...events[0],
      payload: {
        workflowId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        hidden_chain_of_thought: "secret",
      },
    } as unknown as TraceEvent;
    const report = normalizeTraceEvents([invalid, unsupported, hidden], {
      rejectDiagnostics: false,
    });
    expect(report.events).toHaveLength(0);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "invalid_event",
        "unsupported_schema_version",
        "hidden_chain_of_thought",
      ]),
    );
  });

  test("rejects unsupported versions and truncated JSON by default", () => {
    const unsupported = fixtureText.replace('"schemaVersion":"1"', '"schemaVersion":"99"');
    expectCodecError(() => decodeTraceJsonl(unsupported), "unsupported_schema_version");
    expectCodecError(() => decodeTraceJsonl(fixtureText.trimEnd().slice(0, -2)), "truncated_line");
  });

  test("enforces byte, line, and event limits", () => {
    expectCodecError(
      () => encodeTraceJsonl(events, { limits: { maxBytes: 8 } }),
      "max_bytes_exceeded",
    );
    expectCodecError(
      () => encodeTraceJsonl(events, { limits: { maxLines: 1 } }),
      "max_lines_exceeded",
    );
    expectCodecError(
      () => encodeTraceJsonl(events, { limits: { maxEvents: 1 } }),
      "max_events_exceeded",
    );
  });

  test("redacts message, tool, and artifact fields with explicit records", () => {
    const message = events[1] as TraceEvent;
    const redacted = redactTraceEvent(message, { message: true });
    expect(redacted.records).toEqual([
      {
        action: "replace",
        category: "message",
        eventId: message.id,
        field: "payload.content",
        sequence: 1,
      },
    ]);
    expect((redacted.event.payload as { content: string }).content).toBe("[REDACTED]");
    expect(redacted.event.redaction).toEqual({
      status: "partial",
      removedFields: ["payload.content"],
    });
    expect(() =>
      redactTraceEvent(message, { fields: ["payload.hidden_chain_of_thought"] }),
    ).toThrow(TraceCodecError);

    const artifact = TraceEventSchema.parse({
      schemaVersion: "1",
      id: "11111111-1111-4111-8111-111111111111",
      runId: message.runId,
      sequence: 2,
      occurredAt: "2026-08-17T00:00:00.020Z",
      monotonicOffsetMs: 20,
      type: "artifact.recorded",
      payload: {
        artifact: {
          id: "22222222-2222-4222-8222-222222222222",
          sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          mediaType: "text/plain",
          sizeBytes: 4,
          producerNodeId: message.nodeId,
          sourcePath: "/private/secret.txt",
        },
      },
    });
    const artifactRedaction = redactTraceEvent(artifact, { artifact: true });
    expect(artifactRedaction.event.payload).toMatchObject({
      artifact: { mediaType: "[REDACTED]", redacted: true, sourcePath: "[REDACTED]" },
    });
    expect(artifactRedaction.event.payload).not.toHaveProperty("artifact.producerNodeId");
    expect(artifactRedaction.records.map((record) => record.action)).toEqual([
      "replace",
      "remove",
      "replace",
    ]);
  });

  test("supports async sources, chunked UTF-8 import, and event sinks", async () => {
    async function* source(): AsyncGenerator<TraceEvent> {
      yield events[1] as TraceEvent;
      yield events[0] as TraceEvent;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of encodeTraceJsonlStream(source())) chunks.push(chunk);
    const bytes = new TextEncoder().encode(fixtureText);
    const decoded = await decodeTraceJsonlStream([bytes.slice(0, 19), bytes.slice(19)]);
    expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])))).toBe(
      fixtureText,
    );
    expect(decoded.events.map((event) => event.sequence)).toEqual([0, 1]);

    const imported: TraceEvent[] = [];
    const sink: TraceEventSink = { append: (event) => void imported.push(event) };
    await importTraceJsonl(fixtureText, sink);
    expect(imported).toEqual(events);
  });

  test("validates imported contracts after decoding", () => {
    for (const event of fixture.events)
      expect(TraceEventSchema.safeParse(event).success).toBe(true);
  });
});
