import { resolve } from "node:path";
import { z } from "zod";
import { atomic, evidenceDirectory, state } from "./config.js";
import { admissionSchema } from "./journal.js";
import { distribution } from "./metrics-statistics.js";

const eventSchema = z.object({
  kind: z.string(),
  runId: z.string().optional(),
  phase: z.enum(["primary", "preflight"]).optional(),
  actual: z.string().optional(),
  unexpected: z.boolean().optional(),
  terminalAt: z.string().optional(),
  wait: z
    .object({ observedAt: z.string(), resolvedAt: z.string().nullable() })
    .nullable()
    .optional(),
});

export async function journalMetrics(phase: string) {
  const admissions = [];
  let invalidFiles = 0;
  const directory = resolve(state, "journal");

  for await (const path of new Bun.Glob("**/*.json").scan({
    cwd: directory,
    absolute: true,
    onlyFiles: true,
  })) {
    if (path.endsWith(".progress.json")) {
      continue;
    }

    const parsed = admissionSchema.safeParse(await Bun.file(path).json());

    if (!parsed.success) {
      invalidFiles++;
      continue;
    }

    admissions.push(parsed.data);
  }

  const terminals = new Map<string, z.infer<typeof eventSchema>>();
  let invalidEvents = 0;

  for (const group of ["a", "b", "c"]) {
    const file = Bun.file(resolve(directory, `${group}.jsonl`));

    if (!(await file.exists())) {
      continue;
    }

    for (const line of (await file.text()).split("\n").filter((line) => line.trim().length > 0)) {
      try {
        const parsed = eventSchema.safeParse(JSON.parse(line));

        if (parsed.success && parsed.data.kind === "terminal" && parsed.data.runId) {
          terminals.set(parsed.data.runId, parsed.data);
        } else if (!parsed.success) {
          invalidEvents++;
        }
      } catch {
        // A concurrently appended final line can be incomplete. Preserve the count and retry next capture.
        invalidEvents++;
      }
    }
  }

  const records = admissions.map((admission) => {
    const terminal = admission.runId === null ? undefined : terminals.get(admission.runId);

    const difference = (start: string | null | undefined, end: string | null | undefined) =>
      start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;

    return {
      runId: admission.runId,
      slug: admission.slug,
      group: admission.group,
      phase: admission.phase,
      expected: admission.expected,
      actual: terminal?.actual ?? null,
      unexpected: terminal?.unexpected ?? null,
      admissionMs: difference(admission.intentAt, admission.admittedAt),
      terminalFromIntentMs: difference(admission.intentAt, terminal?.terminalAt),
      terminalFromAdmissionMs: difference(admission.admittedAt, terminal?.terminalAt),
      observedApprovalHoldMs: difference(terminal?.wait?.observedAt, terminal?.wait?.resolvedAt),
    };
  });

  const summarize = (selected: typeof records) => {
    const durations = (values: (number | null)[]) =>
      distribution(values.filter((value) => value !== null));

    return {
      admitted: selected.filter((record) => record.runId !== null).length,
      terminal: selected.filter((record) => record.actual !== null).length,
      unexpected: selected.filter((record) => record.unexpected === true).length,
      actual: Object.fromEntries(
        ["succeeded", "failed", "cancelled"].map((status) => [
          status,
          selected.filter((record) => record.actual === status).length,
        ]),
      ),
      admissionMs: durations(selected.map((record) => record.admissionMs)),
      terminalFromIntentMs: durations(selected.map((record) => record.terminalFromIntentMs)),
      terminalFromAdmissionMs: durations(selected.map((record) => record.terminalFromAdmissionMs)),
      observedApprovalHoldMs: durations(selected.map((record) => record.observedApprovalHoldMs)),
    };
  };

  const value = {
    phase,
    scope: "local-driver-journals-only",
    at: new Date().toISOString(),
    invalidFiles,
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

  await atomic(resolve(evidenceDirectory, `playground-performance-${phase}-lifecycle.json`), value);

  return { primary: value.primary, preflight: value.preflight, invalidFiles, invalidEvents };
}

if (import.meta.main) {
  const phase = z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/)
    .parse(process.argv[2]);

  process.stdout.write(`${JSON.stringify(await journalMetrics(phase))}\n`);
}
