import {
  executionKeyString,
  type GraphRevisionView,
  type Json,
  type LogRecord,
  type LoopyView,
  type NodeRunView,
  type RunSnapshotView,
  type RunView,
} from "loopy/contract";
import { HELLO, RELEASE, REVIEW, TRIAGE_V1, TRIAGE_V2 } from "./demo-graphs.ts";
import { base, type EventDraft, type FakeScript } from "./fake.ts";

const minutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString();

const owner = { pid: 4242, host: "devbox", heartbeatAt: minutes(0) };

const workspace = "~/projects/support";

const input = { mailbox: "support@acme.dev", since: "24h" };

function runView(id: string, slug: string, createdAt: string): RunView {
  return {
    id,
    slug,
    workspace,
    loopy: { slug, description: slug === "triage-inbox" ? TRIAGE_V2.graph.meta.description : null },
    input,
    createdAt,
    updatedAt: createdAt,
    owner: null,
    ownerStale: false,
    waitingOn: null,
    status: "queued",
  };
}

type Attempt = { attempt: number; maxAttempts: number; startedAt: string };

/** Builds node records for one run, refusing ids its pinned graph does not have. */
function recorder(view: GraphRevisionView, runId: string) {
  function find(nodeId: string) {
    const node = view.graph.nodes.find((entry) => entry.id === nodeId);

    if (!node) {
      throw new Error(`Revision ${view.revision} has no node '${nodeId}'.`);
    }

    return node;
  }

  function key(nodeId: string) {
    return { runId, nodeId: find(nodeId).id, scope: [] };
  }

  return {
    key,
    running: (nodeId: string, at: Attempt): NodeRunView => ({
      key: key(nodeId),
      ...at,
      receipt: "started",
      status: "running",
    }),
    succeeded: (nodeId: string, at: Attempt, output: Json): NodeRunView => ({
      key: key(nodeId),
      ...at,
      // The engine settles log and join nodes inline, so only executed work has receipts.
      receipt: ["code", "command"].includes(find(nodeId).kind) ? "finished" : "none",
      status: "succeeded",
      output,
      endedAt: minutes(0),
    }),
  };
}

function nodeLog(run: NodeRunView, seq: number, message: string, data?: Json): LogRecord {
  return {
    runId: run.key.runId,
    seq,
    position: {
      kind: "node",
      executionKey: executionKeyString(run.key),
      attempt: run.attempt,
      index: 0,
    },
    level: "info",
    message,
    at: run.startedAt,
    data,
  };
}

const once = { attempt: 1, maxAttempts: 3, startedAt: minutes(-1440) };

const immediate = { attempt: 1, maxAttempts: 1, startedAt: minutes(-1440) };

/** Yesterday's run, pinned to the revision saved before the log node existed. */
function pinnedRun(): RunSnapshotView {
  const id = "run_01JDEMOTRIAGE0PIN";
  const { succeeded } = recorder(TRIAGE_V1, id);
  const fetch = succeeded("0:fetch", once, { stdout: "11 messages", stderr: "", exitCode: 0 });

  return {
    run: {
      ...runView(id, "triage-inbox", minutes(-1441)),
      status: "succeeded",
      output: { sent: 2, spam: 4 },
    },
    nodeRuns: [
      fetch,
      succeeded("1:classify", once, { needsReply: 2, spam: 4 }),
      succeeded("2:reply", once, { sent: 2 }),
      succeeded("3:join", immediate, { sent: 2, spam: 4 }),
    ],
    steps: [],
    logs: [nodeLog(fetch, 1, "Fetched 11 unread messages")],
    hooks: [],
    cursor: 0,
    epoch: "demo",
  };
}

/** The review graph stops at its branch, which the sequence engine does not run yet. */
function reviewRun(): RunSnapshotView {
  const id = "run_01JDEMOREVIEW0BR";
  const message = "Node kind 'branch' is not_yet supported by the sequence engine.";
  const at = { ...once, startedAt: minutes(-90) };
  const { key, succeeded } = recorder(REVIEW, id);

  return {
    run: { ...runView(id, "review", minutes(-91)), input: {}, status: "failed", error: message },
    nodeRuns: [
      succeeded("0:changes", at, { stdout: " M src/app.ts\n", stderr: "", exitCode: 0 }),
      {
        key: key("1:branch"),
        attempt: 1,
        maxAttempts: 1,
        startedAt: at.startedAt,
        endedAt: at.startedAt,
        receipt: "none",
        status: "failed",
        error: { code: "validation", message },
      },
    ],
    steps: [],
    logs: [],
    hooks: [],
    cursor: 0,
    epoch: "demo",
  };
}

/** A finished three-node run, the smallest graph the canvas has to frame. */
function helloRun(): RunSnapshotView {
  const id = "run_01JDEMOHELLO0OK";
  const at = { ...once, startedAt: minutes(-30) };
  const { succeeded } = recorder(HELLO, id);
  const greet = succeeded("0:greet", at, { greeting: "Hello, Ada!" });

  return {
    run: {
      ...runView(id, "hello", minutes(-31)),
      input: { name: "Ada" },
      status: "succeeded",
      output: { greeting: "Hello, Ada!" },
    },
    nodeRuns: [
      greet,
      succeeded("1:log", immediate, null),
      succeeded("2:join", immediate, { greeting: "Hello, Ada!" }),
    ],
    steps: [],
    logs: [nodeLog(greet, 1, "Hello, Ada!")],
    hooks: [],
    cursor: 0,
    epoch: "demo",
  };
}

type Mark = "ok" | "run" | "fail" | "skip" | "wait" | "retry";

/** `item` places the record inside one iteration of the release train's package map. */
type Step = [nodeId: string, mark: Mark, item?: number];

const PACKAGES = ["core", "cli", "dashboard"];

/** Node records for the release train, written as one line per execution. */
function releaseRecords(runId: string, steps: Step[], startedAt: string): NodeRunView[] {
  const { key } = recorder(RELEASE, runId);
  const at = { attempt: 1, maxAttempts: 3, startedAt };

  return steps.map(([nodeId, mark, item]): NodeRunView => {
    const base = {
      ...at,
      key: {
        ...key(nodeId),
        scope: item === undefined ? [] : [{ nodeId: key("15:map").nodeId, index: item }],
      },
      receipt: "none" as const,
    };

    switch (mark) {
      case "ok": {
        const output =
          nodeId === "1:plan" ? { dirty: false, packages: PACKAGES, version: "0.6.0" } : null;

        return { ...base, receipt: "finished", status: "succeeded", output, endedAt: minutes(0) };
      }

      case "run": {
        return { ...base, receipt: "started", status: "running" };
      }

      case "fail": {
        const error = {
          code: "exit" as const,
          message: "npm publish exited with code 1: 403 Forbidden",
        };

        return { ...base, receipt: "finished", status: "failed", error, endedAt: minutes(0) };
      }

      case "skip": {
        return { ...base, status: "skipped", endedAt: minutes(0) };
      }

      case "wait": {
        return { ...base, maxAttempts: 1, status: "waiting", wakeAt: minutes(232) };
      }

      case "retry": {
        const error = {
          code: "exit" as const,
          message: "bun run build exited with code 1: out of memory",
        };

        return {
          ...base,
          attempt: 2,
          receipt: "finished",
          status: "retrying",
          error,
          endedAt: minutes(0),
          nextRetryAt: minutes(0.5),
        };
      }
    }
  });
}

/** Everything up to the package map: the clean-tree branch and the parallel checks. */
const RELEASE_CHECKS: Step[] = [
  ["0:status", "ok"],
  ["1:plan", "ok"],
  ["2:branch", "ok"],
  ["3:fail", "skip"],
  ["4:log", "ok"],
  ["5:join", "ok"],
  ["6:join", "ok"],
  ["7:parallel", "ok"],
  ["8:lint", "ok"],
  ["9:join", "ok"],
  ["10:test", "ok"],
  ["11:join", "ok"],
  ["12:typecheck", "ok"],
  ["13:join", "ok"],
  ["14:join", "ok"],
];

/** One package published cleanly: upload succeeded, so the rescue handler was skipped. */
function published(item: number): Step[] {
  return [
    ["16:publish/build", "ok", item],
    ["17:publish/pack", "ok", item],
    ["18:publish/rescue", "ok", item],
    ["19:publish/upload", "ok", item],
    ["20:publish/join", "ok", item],
    ["21:publish/format", "skip", item],
    ["22:publish/log", "skip", item],
    ["23:publish/notify", "skip", item],
    ["24:publish/join", "skip", item],
    ["25:publish/join", "ok", item],
    ["26:join", "ok", item],
  ];
}

/**
 * A release mid-flight: the checks passed, core published, cli's upload failed and its rescue
 * handler is notifying, and dashboard's build failed once and waits to retry.
 */
function releaseLive(): RunSnapshotView {
  const id = "run_01JDEMORELEASE0RUN";
  const startedAt = minutes(-6);

  const nodeRuns = releaseRecords(
    id,
    [
      ...RELEASE_CHECKS,
      ["15:map", "run"],
      ...published(0),
      ["16:publish/build", "ok", 1],
      ["17:publish/pack", "ok", 1],
      ["18:publish/rescue", "run", 1],
      ["19:publish/upload", "fail", 1],
      ["21:publish/format", "ok", 1],
      ["22:publish/log", "ok", 1],
      ["23:publish/notify", "run", 1],
      ["16:publish/build", "retry", 2],
    ],
    startedAt,
  );

  return {
    run: {
      ...runView(id, "release-train", minutes(-6)),
      input: { channel: "stable" },
      owner,
      status: "running",
    },
    nodeRuns,
    steps: [],
    logs: nodeRuns
      .filter((record) => record.status === "failed" || record.key.nodeId === "22:publish/log")
      .map((record, index) =>
        nodeLog(
          record,
          index + 1,
          record.status === "failed"
            ? "npm ERR! 403 Forbidden"
            : "cli failed to publish: 403 Forbidden",
        ),
      ),
    hooks: [],
    cursor: 0,
    epoch: "demo",
  };
}

/** A release that published everything and now waits for sign-off before it deploys. */
function releaseWaiting(): RunSnapshotView {
  const id = "run_01JDEMORELEASE0WAIT";

  const nodeRuns = releaseRecords(
    id,
    [
      ...RELEASE_CHECKS,
      ["15:map", "ok"],
      ...published(0),
      ...published(1),
      ...published(2),
      ["27:join", "ok"],
      ["28:notes", "ok"],
      ["29:approve", "wait"],
    ],
    minutes(-48),
  );

  return {
    run: {
      ...runView(id, "release-train", minutes(-48)),
      input: { channel: "beta" },
      status: "suspended",
      wakeAt: minutes(232),
    },
    nodeRuns,
    steps: [],
    logs: [],
    hooks: [],
    cursor: 0,
    epoch: "demo",
  };
}

const LIVE_ID = "run_01JDEMO7TRIAGE";

const queued = runView(LIVE_ID, "triage-inbox", minutes(-1));

function node(record: NodeRunView): EventDraft {
  return { entity: "node", kind: record.status, runId: LIVE_ID, record };
}

function log(record: LogRecord): EventDraft {
  return { entity: "log", kind: "written", runId: LIVE_ID, record };
}

/** The live run walks the current revision, including one failed attempt that retries. */
function liveBatches(): EventDraft[][] {
  const now = { attempt: 1, maxAttempts: 3, startedAt: minutes(0) };
  const { running, succeeded } = recorder(TRIAGE_V2, LIVE_ID);
  const fetch = running("0:fetch", now);
  const retry = { ...now, attempt: 2 };
  const logNode = succeeded("2:log", { ...now, maxAttempts: 1 }, null);
  const reply = running("3:reply", now);

  return [
    [
      {
        entity: "run",
        kind: "claimed",
        runId: LIVE_ID,
        record: { ...base(queued), owner, status: "running" },
      },
    ],
    [node(fetch)],
    [log(nodeLog(fetch, 1, "Fetched 14 unread messages from support@acme.dev"))],
    [node(succeeded("0:fetch", now, { stdout: "14 messages", stderr: "", exitCode: 0 }))],
    [node(running("1:classify", now))],
    [
      node({
        ...running("1:classify", now),
        status: "retrying",
        receipt: "finished",
        error: { code: "exit", message: "classify.ts exited with code 1: model timeout" },
        endedAt: minutes(0),
        nextRetryAt: minutes(0.05),
      }),
    ],
    [node(running("1:classify", retry))],
    [node(succeeded("1:classify", retry, { needsReply: 3, spam: 3 }))],
    [node(logNode), log(nodeLog(logNode, 2, "Classified unread mail"))],
    [node(reply)],
    [log(nodeLog(reply, 3, "Sent 3 replies"))],
    [node(succeeded("3:reply", now, { sent: 3 }))],
    [node(succeeded("4:join", { ...now, maxAttempts: 1 }, { sent: 3, spam: 3 }))],
    [
      {
        entity: "run",
        kind: "finished",
        runId: LIVE_ID,
        record: { ...base(queued), status: "succeeded", output: { sent: 3, spam: 3 } },
      },
    ],
  ];
}

const empty = { queued: 0, running: 0, suspended: 0, succeeded: 0, failed: 0, cancelled: 0 };

const triage: LoopyView = {
  slug: "triage-inbox",
  workspace,
  description: TRIAGE_V2.graph.meta.description,
  scope: "project",
  mode: "sandbox",
  input: { mailbox: "string", since: "string" },
  schedule: { cron: "0 9 * * 1-5", tz: "Europe/London", enabled: true, nextFireAt: minutes(600) },
  lastRun: queued,
  counts: empty,
};

const review: LoopyView = {
  slug: "review",
  workspace,
  description: null,
  scope: "project",
  mode: "sandbox",
  input: { "instructions?": "string" },
  schedule: null,
  lastRun: null,
  counts: empty,
};

const hello: LoopyView = {
  ...review,
  slug: "hello",
  description: null,
  input: { name: "string", "enthusiastic?": "boolean" },
};

const release: LoopyView = {
  ...review,
  slug: "release-train",
  description: RELEASE.graph.meta.description,
  input: { channel: "string", "notes?": "string" },
};

/**
 * A live triage run on the latest revision, an older run pinned to the first revision, a review
 * run that stopped at its branch, a finished hello run, and two release-train runs: one mid-way
 * through its package map and one waiting for sign-off.
 */
export function demoScript(): FakeScript {
  const pinned = pinnedRun();
  const stopped = reviewRun();
  const greeted = helloRun();
  const releasing = releaseLive();
  const signOff = releaseWaiting();

  return {
    epoch: "demo",
    intervalMs: 1200,
    loopies: [
      triage,
      { ...review, lastRun: stopped.run },
      { ...hello, lastRun: greeted.run },
      { ...release, lastRun: releasing.run },
    ],
    schedules: [
      {
        workspace,
        slug: triage.slug,
        cron: "0 9 * * 1-5",
        tz: "Europe/London",
        enabled: true,
        input,
        nextFireAt: minutes(600),
        lastFireKey: "triage-inbox@2026-10-16T08:00Z",
        version: 3,
      },
    ],
    graphs: [TRIAGE_V1, TRIAGE_V2, REVIEW, HELLO, RELEASE],
    pins: {
      [LIVE_ID]: TRIAGE_V2.revision,
      [pinned.run.id]: TRIAGE_V1.revision,
      [stopped.run.id]: REVIEW.revision,
      [greeted.run.id]: HELLO.revision,
      [releasing.run.id]: RELEASE.revision,
      [signOff.run.id]: RELEASE.revision,
    },
    runs: [
      { run: queued, nodeRuns: [], steps: [], logs: [], hooks: [], cursor: 0, epoch: "demo" },
      pinned,
      stopped,
      greeted,
      releasing,
      signOff,
    ],
    batches: liveBatches(),
  };
}
