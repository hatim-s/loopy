export type CodexCancellationMetadata = {
  provider: "codex";
  signal: "SIGTERM";
  escalationSignal: "SIGKILL";
  gracePeriodMs: number;
  reason: string;
  terminateProcessGroup: boolean;
};

export function createCodexCancellationMetadata(
  reason = "cancelled",
  gracePeriodMs = 5_000,
): CodexCancellationMetadata {
  if (!Number.isInteger(gracePeriodMs) || gracePeriodMs < 0)
    throw new Error("gracePeriodMs must be a non-negative integer");
  return {
    provider: "codex",
    signal: "SIGTERM",
    escalationSignal: "SIGKILL",
    gracePeriodMs,
    reason,
    terminateProcessGroup: true,
  };
}

export const codexCancellationMetadata = createCodexCancellationMetadata;
export const buildCodexCancellationMetadata = createCodexCancellationMetadata;
