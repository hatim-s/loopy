import type {
  EngineLog,
  EngineRun,
  EngineRunStatus,
  EngineStep,
  RunOutcome,
  Schedule,
} from "../core/index.js";

export class OwnershipError extends Error {
  constructor(runId: string) {
    super(`Run '${runId}' is not owned by this token. Claim the run before writing.`);
    this.name = "OwnershipError";
  }
}

export interface RunStore {
  createRun(run: EngineRun): Promise<void>;
  getRun(id: string): Promise<EngineRun | undefined>;
  listRuns(filter?: { slug?: string; status?: EngineRunStatus }): Promise<EngineRun[]>;
  claim(runId: string, token: string): Promise<EngineRun>;
  heartbeat(runId: string, token: string): Promise<boolean>;
  suspend(runId: string, token: string, wakeAt?: string): Promise<void>;
  finishRun(runId: string, token: string, outcome: RunOutcome): Promise<void>;
  release(runId: string, token: string): Promise<void>;
  getSteps(runId: string): Promise<EngineStep[]>;
  putStep(runId: string, token: string, step: EngineStep): Promise<void>;
  appendLog(runId: string, token: string, log: EngineLog): Promise<void>;
  getLogs(runId: string, after?: number): Promise<EngineLog[]>;
  dueRuns(now: string): Promise<EngineRun[]>;
  nextWakeAt(): Promise<string | undefined>;
  putSchedule(schedule: Schedule): Promise<void>;
  listSchedules(): Promise<Schedule[]>;
  deleteSchedule(slug: string): Promise<void>;
  fireSchedule(slug: string, fireKey: string, run: EngineRun, nextFireAt: string): Promise<boolean>;
}
