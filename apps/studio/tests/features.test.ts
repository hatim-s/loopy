import { describe, expect, test } from "vitest";
import {
  createDebuggerState,
  debuggerReducer,
  mergeDebuggerEvents,
  reconstructDebuggerState,
} from "../src/features/debugger/reducer.ts";
import { buildTimeline, legalControls, replayEvents } from "../src/features/debugger/view-model.ts";

const event = (
  id: string,
  sequence: number,
  type: string,
  extras: Record<string, unknown> = {},
) => ({
  id,
  eventId: id,
  runId: "run-1",
  sequence,
  type,
  occurredAt: `2026-08-17T00:00:0${sequence}.000Z`,
  ...extras,
});

describe("Studio debugger view models", () => {
  test("merges out-of-order SSE and reconnect duplicates by stable event ID", () => {
    const first = event("e-2", 2, "node.started", { nodeId: "n-1" });
    const second = event("e-1", 1, "run.started");
    const merged = mergeDebuggerEvents(
      [first],
      [
        second,
        first,
        event("e-2", 2, "node.started", { nodeId: "n-1", payload: { detail: "richer" } }),
      ],
    );
    expect(merged.map((item) => item.id)).toEqual(["e-1", "e-2"]);
    expect(merged[1]?.payload).toEqual({ detail: "richer" });
  });

  test("refresh reconstructs attempts and terminal status from server state", () => {
    const snapshot = {
      runId: "run-1",
      status: "completed" as const,
      events: [
        event("a-1", 1, "attempt.created", { nodeId: "n-1", attemptId: "a-1" }),
        event("a-2", 2, "node.started", { nodeId: "n-1", attemptId: "a-1" }),
        event("a-3", 3, "node.completed", { nodeId: "n-1", attemptId: "a-1" }),
      ],
    };
    const state = reconstructDebuggerState(snapshot);
    expect(state.status).toBe("completed");
    expect(state.attempts[0]).toMatchObject({
      attemptId: "a-1",
      nodeId: "n-1",
      status: "succeeded",
    });
    expect(state.lastSequence).toBe(3);
  });

  test("legal controls disable pause/resume/retry based on run and attempt state", () => {
    expect(legalControls("live")).toMatchObject({
      pause: true,
      resume: false,
      cancel: true,
      retryFailedNode: false,
    });
    expect(
      legalControls("paused", { attemptId: "a", nodeId: "n", attempt: 1, status: "failed" }),
    ).toMatchObject({ pause: false, resume: true, retryFailedNode: true, fork: true });
    expect(
      legalControls("completed", { attemptId: "a", nodeId: "n", attempt: 1, status: "succeeded" })
        .retryFailedNode,
    ).toBe(false);
  });

  test("timeline keeps event IDs and ordering for graph/timeline correlation", () => {
    const items = buildTimeline([
      event("e-2", 2, "node.completed", { nodeId: "n" }),
      event("e-1", 1, "run.started"),
    ]);
    expect(items.map((item) => item.eventId)).toEqual(["e-1", "e-2"]);
    expect(items[1]).toMatchObject({ nodeId: "n", type: "node.completed" });
  });

  test("replay only invokes the local playback callback and returns event count", async () => {
    const played: string[] = [];
    const count = await replayEvents(
      [event("e-2", 2, "node.completed"), event("e-1", 1, "run.started")],
      (item) => {
        played.push(item.id as string);
      },
    );
    expect(count).toBe(2);
    expect(played).toEqual(["e-1", "e-2"]);
  });

  test("reducer selection is stable when a reconnect appends events", () => {
    const initial = debuggerReducer(createDebuggerState("run-1"), {
      type: "events",
      events: [event("e-1", 1, "run.started")],
    });
    const selected = debuggerReducer(initial, { type: "select_event", eventId: "e-1" });
    const recovered = debuggerReducer(selected, {
      type: "events",
      reconnect: true,
      events: [event("e-1", 1, "run.started"), event("e-2", 2, "run.completed")],
    });
    expect(recovered.selectedEventId).toBe("e-1");
    expect(recovered.reconnects).toBe(1);
    expect(recovered.events).toHaveLength(2);
  });
});
