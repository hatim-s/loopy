export type ClaudeCancellationMetadata = {
  provider: "claude";
  signal: "SIGTERM";
  escalationSignal: "SIGKILL";
  gracePeriodMs: number;
  reason: string;
  terminateProcessGroup: boolean;
};

export function createClaudeCancellationMetadata(
  reason = "cancelled",
  gracePeriodMs = 5_000,
): ClaudeCancellationMetadata {
  if (!Number.isInteger(gracePeriodMs) || gracePeriodMs < 0)
    throw new Error("gracePeriodMs must be a non-negative integer");
  return {
    provider: "claude",
    signal: "SIGTERM",
    escalationSignal: "SIGKILL",
    gracePeriodMs,
    reason,
    terminateProcessGroup: true,
  };
}

export const claudeCancellationMetadata = createClaudeCancellationMetadata;
export const buildClaudeCancellationMetadata = createClaudeCancellationMetadata;
