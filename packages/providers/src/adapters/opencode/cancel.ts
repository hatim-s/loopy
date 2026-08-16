export type OpenCodeCancellation = {
  attemptId: string;
  signal: "SIGTERM";
  gracePeriodMs: number;
  reason: string;
  killProcessGroup: true;
};

export function cancellationMetadata(
  attemptId: string,
  reason = "cancelled by user",
  gracePeriodMs = 2_000,
): OpenCodeCancellation {
  if (!attemptId.trim()) throw new TypeError("attemptId must not be empty.");
  if (!Number.isInteger(gracePeriodMs) || gracePeriodMs < 0)
    throw new TypeError("gracePeriodMs must be a non-negative integer.");
  return { attemptId, signal: "SIGTERM", gracePeriodMs, reason, killProcessGroup: true };
}

export const buildOpenCodeCancellation = cancellationMetadata;
