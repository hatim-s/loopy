import { useState } from "react";
import type { DebuggerEvent } from "../types";

export function ApprovalControls({
  attempts,
  events,
  canDecide,
  onDecision,
}: {
  attempts: readonly { nodeId: string; attemptId: string; status: string }[];
  events: readonly DebuggerEvent[];
  canDecide: boolean;
  onDecision: (
    nodeId: string,
    attemptId: string,
    decision: "approved" | "rejected",
  ) => Promise<void>;
}) {
  const [pending, setPending] = useState<string>();
  const decide = async (nodeId: string, attemptId: string, decision: "approved" | "rejected") => {
    setPending(attemptId);
    try {
      await onDecision(nodeId, attemptId, decision);
    } finally {
      setPending(undefined);
    }
  };
  return attempts
    .filter((attempt) => attempt.status === "blocked_approval")
    .map((attempt) => {
      const request = [...events]
        .reverse()
        .find(
          (event) => event.type === "approval.requested" && event.attemptId === attempt.attemptId,
        );
      const message = request?.payload?.message;
      return (
        <div key={attempt.attemptId} className="builder-approval">
          <strong>
            {typeof message === "string" ? message : `Approval needed for ${attempt.nodeId}`}
          </strong>
          {!canDecide ? <span>Resume the run before deciding.</span> : null}
          <button
            type="button"
            disabled={!canDecide || Boolean(pending)}
            onClick={() => void decide(attempt.nodeId, attempt.attemptId, "approved")}
          >
            Approve step
          </button>
          <button
            type="button"
            disabled={!canDecide || Boolean(pending)}
            onClick={() => void decide(attempt.nodeId, attempt.attemptId, "rejected")}
          >
            Reject step
          </button>
        </div>
      );
    });
}
