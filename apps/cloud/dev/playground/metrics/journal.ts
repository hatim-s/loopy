import { resolve } from "node:path";
import { boundaryOptions } from "@loopy/contract";
import { Result, Schema } from "effect";
import { distribution } from "../../shared/stats";
import { evidence, state } from "../config";
import { atomic } from "../files";
import {
  eventsPath,
  groups,
  type JournalEvent,
  journalDirectory,
  journalEventSchema,
  readAdmissions,
} from "../journal";
import { decodePhaseName } from "./artifacts";
import { countBy, elapsedMs, known } from "./statistics";

type Terminal = Extract<JournalEvent, { kind: "terminal" }>;

const decodeEvent = Schema.decodeUnknownResult(journalEventSchema, boundaryOptions);

async function terminalEvents() {
  const terminals = new Map<string, Terminal>();
  let invalidEvents = 0;

  for (const group of groups) {
    const file = Bun.file(eventsPath(state, group));

    if (!(await file.exists())) {
      continue;
    }

    for (const line of (await file.text()).split("\n").filter((value) => value.trim().length > 0)) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(line);
      } catch {
        // A concurrently appended final line can be incomplete. Preserve the count and retry next capture.
        invalidEvents++;
        continue;
      }

      const decoded = decodeEvent(parsed);

      if (Result.isFailure(decoded)) {
        invalidEvents++;
      } else if (decoded.success.kind === "terminal") {
        terminals.set(decoded.success.runId, decoded.success);
      }
    }
  }

  return { terminals, invalidEvents };
}

export async function journalMetrics(phase: string) {
  const admissions = await readAdmissions(journalDirectory(state));
  const { terminals, invalidEvents } = await terminalEvents();

  const records = admissions.map((admission) => {
    const terminal = admission.runId === null ? undefined : terminals.get(admission.runId);

    return {
      runId: admission.runId,
      slug: admission.slug,
      group: admission.group,
      phase: admission.phase,
      expected: admission.expected,
      actual: terminal?.actual ?? null,
      unexpected: terminal?.unexpected ?? null,
      admissionMs: elapsedMs(admission.intentAt, admission.admittedAt),
      terminalFromIntentMs: elapsedMs(admission.intentAt, terminal?.terminalAt),
      terminalFromAdmissionMs: elapsedMs(admission.admittedAt, terminal?.terminalAt),
      observedApprovalHoldMs: elapsedMs(terminal?.wait?.observedAt, terminal?.wait?.resolvedAt),
    };
  });

  const summarize = (selected: typeof records) => ({
    admitted: selected.filter((record) => record.runId !== null).length,
    terminal: selected.filter((record) => record.actual !== null).length,
    unexpected: selected.filter((record) => record.unexpected === true).length,
    actual: countBy(
      selected.flatMap((record) => (record.actual === null ? [] : [record.actual])),
      (actual) => actual,
    ),
    admissionMs: distribution(known(selected.map((record) => record.admissionMs))),
    terminalFromIntentMs: distribution(
      known(selected.map((record) => record.terminalFromIntentMs)),
    ),
    terminalFromAdmissionMs: distribution(
      known(selected.map((record) => record.terminalFromAdmissionMs)),
    ),
    observedApprovalHoldMs: distribution(
      known(selected.map((record) => record.observedApprovalHoldMs)),
    ),
  });

  const value = {
    phase,
    scope: "local-driver-journals-only",
    at: new Date().toISOString(),
    invalidEvents,
    primary: summarize(records.filter((record) => record.phase === "primary")),
    preflight: summarize(records.filter((record) => record.phase === "preflight")),
    records,
    limits: [
      "Admission includes durable journal writes, client API-slot wait and HTTP body/schema handling.",
      "Terminal time comes from server run.updatedAt; wall time includes queue, scheduler polling, execution and approval holds.",
      "Observed approval hold starts at runner observation, not durable wait creation.",
      "No SQL queue-to-claim timing is available until a safe copied snapshot is supplied.",
    ],
  };

  await atomic(resolve(evidence, `playground-performance-${phase}-lifecycle.json`), value);

  return { primary: value.primary, preflight: value.preflight, invalidEvents };
}

if (import.meta.main) {
  process.stdout.write(
    `${JSON.stringify(await journalMetrics(decodePhaseName(process.argv[2])))}\n`,
  );
}
