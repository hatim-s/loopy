import type { AdmissionRequest, AdmissionResult, RuntimeIdentity } from "../application/ports.js";
import type { AttemptRecord, Json, RunEvent, RunRecord } from "../core/model.js";

export const PROTOCOL_VERSION = 1 as const;
export type Capability = "read" | "run" | "resume" | "cancel" | "publish";
export type Capabilities = {
  protocol: typeof PROTOCOL_VERSION;
  runtime: RuntimeIdentity;
  operations: readonly Capability[];
  executors: readonly string[];
};
export type RunRequest = Omit<AdmissionRequest, "fingerprint">;
export type RunResponse = AdmissionResult;
export type InspectResponse = { run: RunRecord; attempts: AttemptRecord[] };
export type EventsResponse = { events: RunEvent[]; cursor: number };
export type ResumeRequest = { retryUncertain?: boolean };
export type ProtocolError = {
  code: "unauthorized" | "forbidden" | "not-found" | "conflict" | "invalid-input" | "unsupported";
  message: string;
  details?: Json;
};
