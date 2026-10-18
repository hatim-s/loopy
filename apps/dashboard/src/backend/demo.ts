import type { Json, LogRecord, LoopyView, RunView, StepRecord } from "loopy/contract";
import { base, type EventDraft, type FakeScript } from "./fake.ts";

const RUN_ID = "run_01JDEMO7TRIAGE";

const minutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString();

const owner = { pid: 4242, host: "devbox", heartbeatAt: minutes(0) };

const queued: RunView = {
  id: RUN_ID,
  slug: "triage-inbox",
  workspace: "~/projects/support",
  loopy: { slug: "triage-inbox", description: "Triage the support inbox and draft replies." },
  input: { mailbox: "support@acme.dev", since: "24h" },
  createdAt: minutes(-1),
  updatedAt: minutes(-1),
  owner: null,
  ownerStale: false,
  waitingOn: null,
  status: "queued",
};

function running(): RunView {
  return { ...base(queued), owner, status: "running" };
}

const step = {
  runId: RUN_ID,
  input: null,
  attempt: 1,
  maxAttempts: 3,
} as const;

function started(seq: number, key: string, kind: StepRecord["kind"]): EventDraft {
  return {
    entity: "step",
    kind: "running",
    runId: RUN_ID,
    record: { ...step, seq, key, kind, startedAt: minutes(0), status: "running" },
  };
}

function succeeded(seq: number, key: string, kind: StepRecord["kind"], output: Json): EventDraft {
  return {
    entity: "step",
    kind: "succeeded",
    runId: RUN_ID,
    record: {
      ...step,
      seq,
      key,
      kind,
      startedAt: minutes(-0.05),
      endedAt: minutes(0),
      finishOrder: seq,
      output,
      status: "succeeded",
    },
  };
}

let logSeq = 0;

function log(
  position: LogRecord["position"],
  level: LogRecord["level"],
  message: string,
  data?: Json,
): EventDraft {
  logSeq += 1;

  return {
    entity: "log",
    kind: "written",
    runId: RUN_ID,
    record: { runId: RUN_ID, seq: logSeq, position, level, message, at: minutes(0), data },
  };
}

const inStep = (seq: number, index: number) => ({ kind: "step", seq, attempt: 1, index }) as const;

const hookToken = "hk_demo_approve";

const approval: EventDraft[] = [
  {
    entity: "step",
    kind: "waiting",
    runId: RUN_ID,
    record: {
      ...step,
      seq: 3,
      key: "approve-replies",
      kind: "hook",
      startedAt: minutes(0),
      wakeAt: minutes(30),
      status: "waiting",
    },
  },
  {
    entity: "hook",
    kind: "created",
    runId: RUN_ID,
    record: {
      token: hookToken,
      runId: RUN_ID,
      seq: 3,
      name: "approve-replies",
      createdAt: minutes(0),
    },
  },
  {
    entity: "run",
    kind: "suspended",
    runId: RUN_ID,
    record: {
      ...base(queued),
      owner: null,
      status: "suspended",
      wakeAt: minutes(30),
      waitingOn: {
        hook: "approve-replies",
        token: hookToken,
        seq: 3,
        expiresAt: minutes(30),
        since: minutes(0),
      },
    },
  },
];

const loopy: LoopyView = {
  slug: "triage-inbox",
  description: "Sort the support inbox and draft replies for approval.",
  scope: "project",
  mode: "sandbox",
  input: { mailbox: "string", since: "string" },
  schedule: { cron: "0 9 * * 1-5", tz: "Europe/London", enabled: true, nextFireAt: minutes(600) },
  lastRun: queued,
  counts: { queued: 1, running: 0, suspended: 0, succeeded: 12, failed: 1, cancelled: 0 },
};

/** A support triage run that classifies mail, waits for approval, then sends replies. */
export function demoScript(): FakeScript {
  return {
    epoch: "demo",
    intervalMs: 1200,
    loopies: [loopy],
    schedules: [
      {
        workspace: queued.workspace,
        slug: loopy.slug,
        cron: "0 9 * * 1-5",
        tz: "Europe/London",
        enabled: true,
        input: { mailbox: "support@acme.dev", since: "24h" },
        nextFireAt: minutes(600),
        lastFireKey: "triage-inbox@2026-10-16T08:00Z",
        version: 3,
      },
    ],
    runs: [{ run: queued, nodeRuns: [], steps: [], logs: [], hooks: [], cursor: 0, epoch: "demo" }],
    batches: [
      [{ entity: "run", kind: "claimed", runId: RUN_ID, record: running() }],
      [started(1, "fetch-unread", "command")],
      [log(inStep(1, 0), "info", "Fetched 14 unread messages from support@acme.dev")],
      [succeeded(1, "fetch-unread", "command", { count: 14 })],
      [started(2, "classify", "function")],
      [
        log(inStep(2, 0), "info", "Classified 14 messages", { billing: 5, bug: 6, spam: 3 }),
        log(inStep(2, 1), "warn", "2 messages had no subject; used the first line instead"),
      ],
      [succeeded(2, "classify", "function", { needsReply: 3 })],
      [
        log(
          { kind: "workflow", afterStep: 2, afterFinish: 2, index: 0 },
          "info",
          "3 replies drafted",
        ),
      ],
      approval,
      [{ entity: "run", kind: "claimed", runId: RUN_ID, record: running() }],
      [succeeded(3, "approve-replies", "hook", { approved: true })],
      [started(4, "send-replies", "command")],
      [log(inStep(4, 0), "info", "Sent 3 replies")],
      [succeeded(4, "send-replies", "command", { sent: 3 })],
      [
        {
          entity: "run",
          kind: "finished",
          runId: RUN_ID,
          record: { ...base(queued), status: "succeeded", output: { sent: 3, skipped: 11 } },
        },
      ],
    ],
  };
}
