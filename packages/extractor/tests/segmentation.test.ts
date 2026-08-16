import { readFileSync } from "node:fs";
import type { TraceEvent } from "@loopy/contracts";
import { describe, expect, test } from "vitest";
import { createEvidenceReferences, stableEvidenceId } from "../src/evidence.js";
import { classifyFeature, inferCandidateVariables } from "../src/features.js";
import { segmentTrace, validateAndSortTraceEvents } from "../src/segmentation.js";

function fixture(name: string): TraceEvent[] {
  return JSON.parse(
    readFileSync(new URL(`../../../fixtures/sessions/${name}.json`, import.meta.url), "utf8"),
  ) as TraceEvent[];
}

describe("deterministic extraction segmentation", () => {
  test("validates, sorts, and warns without accepting malformed events", () => {
    const events = fixture("successful");
    const result = validateAndSortTraceEvents([
      events[4],
      events[0],
      { ...events[1], payload: {} },
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual([0, 4]);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "invalid_event",
      "out_of_order",
      "sequence_gap",
    ]);
  });

  test("segments successful work and produces stable evidence from actual event IDs", () => {
    const first = segmentTrace(fixture("successful"));
    const second = segmentTrace(fixture("successful").reverse());
    expect(first.events.map((event) => event.id)).toEqual(second.events.map((event) => event.id));
    expect(first.failures).toHaveLength(0);
    expect(first.verification).toEqual([
      {
        verificationId: first.verification[0]?.verificationId,
        check: "tests",
        eventIds: [first.events[6]?.id, first.events[7]?.id],
        result: "passed",
      },
    ]);
    expect(first.toolClusters[0]?.toolNames).toEqual(["git status"]);
    expect(
      first.candidateVariables.find((candidate) => candidate.name === "apiKey"),
    ).toBeUndefined();
    expect(
      first.candidateVariables.find((candidate) => candidate.name === "cwd")?.observedValues,
    ).toEqual(["<path>"]);
    expect(
      first.evidence.every((reference) =>
        reference.eventIds.every((id) => first.events.some((event) => event.id === id)),
      ),
    ).toBe(true);
    expect(first.evidence.map((reference) => reference.evidenceId)).toEqual(
      second.evidence.map((reference) => reference.evidenceId),
    );
  });

  test("keeps failed attempts distinct from observed recovery", () => {
    const result = segmentTrace(fixture("failed-then-recovered"));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.kind).toBe("attempt_failed");
    expect(result.failures[0]?.resolved).toBe(true);
    expect(result.recoveries).toHaveLength(1);
    expect(result.recoveries[0]?.eventIds).toEqual([result.events[2]?.id]);
    expect(result.warnings).toEqual([]);
  });

  test("groups child sessions and reports missing causal references", () => {
    const events = fixture("subagent-heavy");
    const result = segmentTrace({
      events: [
        ...events,
        {
          ...events[5],
          id: "12000000-0000-4000-8000-000000000008",
          sequence: 7,
          sessionId: "orphan-session",
          payload: { parentSessionId: "missing-session" },
        },
      ],
    });
    expect(result.causality).toHaveLength(3);
    expect(result.causality.find((group) => group.rootSessionId === "root-session")?.subagent).toBe(
      true,
    );
    expect(
      result.warnings.some(
        (warning) =>
          warning.code === "invalid_causal_reference" &&
          warning.referencedEventId === "missing-session",
      ),
    ).toBe(true);
  });

  test("classifies environment discovery and side effects deterministically", () => {
    const events = fixture("successful");
    const sample = events[4];
    if (!sample) throw new Error("successful fixture is missing its tool event");
    expect(classifyFeature(sample).class).toBe("environment_discovery");
    expect(
      classifyFeature({
        ...sample,
        type: "tool.requested",
        payload: { tool: "write_file", input: {} },
      } as unknown as TraceEvent).class,
    ).toBe("side_effect");
    const variables = inferCandidateVariables([
      {
        ...sample,
        payload: {
          cwd: "/private/user/project",
          apiKey: "do-not-retain",
          branch: "feature/demo",
          version: "1.2.3",
        },
      } as unknown as TraceEvent,
    ]);
    expect(variables.find((variable) => variable.name === "apiKey")).toBeUndefined();
    expect(variables.find((variable) => variable.name === "cwd")?.observedValues).toEqual([
      "<path>",
    ]);
    expect(variables.find((variable) => variable.name === "branch")?.observedValues).toEqual([
      "feature/demo",
    ]);
  });

  test("evidence IDs are stable, ordered, and warn on missing references", () => {
    const events = fixture("successful");
    const ids = [events[7]?.id, events[6]?.id] as string[];
    const one = createEvidenceReferences(events, [
      { kind: "verification", eventIds: ids },
      { kind: "verification", eventIds: ["missing-event"] },
    ]);
    const two = createEvidenceReferences(events.slice().reverse(), [
      { kind: "verification", eventIds: ids },
    ]);
    expect(one.references[0]?.evidenceId).toBe(stableEvidenceId("verification", ids));
    expect(one.references[0]?.eventIds).toEqual([events[6]?.id, events[7]?.id]);
    expect(one.references.map((reference) => reference.evidenceId)).toEqual(
      two.references.map((reference) => reference.evidenceId),
    );
    expect(
      one.warnings.some(
        (warning) =>
          warning.code === "missing_event" && warning.referencedEventId === "missing-event",
      ),
    ).toBe(true);
  });
});
