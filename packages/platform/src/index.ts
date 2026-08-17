import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { nextOccurrence } from "@loopy/scheduler";

export type ScheduleOverlapPolicy = "skip" | "queue" | "cancel_previous";
export type ScheduleMissedPolicy = "skip" | "run_once";

export type LocalSchedule = {
  id: string;
  name: string;
  workflowId: string;
  workflowVersion: number;
  input: Record<string, unknown>;
  expression: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  missedPolicy: ScheduleMissedPolicy;
  enabled: boolean;
  nextFireAt?: string;
  lastFireAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleFile = { schemaVersion: "1"; schedules: LocalSchedule[] };

export type ScheduleStore = {
  list(): LocalSchedule[];
  get(id: string): LocalSchedule | undefined;
  put(schedule: LocalSchedule): LocalSchedule;
  remove(id: string): boolean;
};

const scheduleFile = (projectDir: string) => join(resolve(projectDir), ".loopy", "schedules.json");

function readScheduleFile(path: string): ScheduleFile {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ScheduleFile>;
    if (value.schemaVersion !== "1" || !Array.isArray(value.schedules))
      throw new Error("invalid schedule file");
    return { schemaVersion: "1", schedules: value.schedules as LocalSchedule[] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: "1", schedules: [] };
    throw new Error(
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(tmpdir(), `loopy-schedules-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file was already renamed.
    }
  }
}

export class FileScheduleStore implements ScheduleStore {
  readonly path: string;
  constructor(projectDir: string) {
    this.path = scheduleFile(projectDir);
  }
  private save(schedules: LocalSchedule[]): void {
    atomicWrite(this.path, `${JSON.stringify({ schemaVersion: "1", schedules }, null, 2)}\n`);
  }
  list(): LocalSchedule[] {
    return readScheduleFile(this.path).schedules.sort((a, b) => a.id.localeCompare(b.id));
  }
  get(id: string): LocalSchedule | undefined {
    return this.list().find((schedule) => schedule.id === id);
  }
  put(schedule: LocalSchedule): LocalSchedule {
    const schedules = this.list().filter((current) => current.id !== schedule.id);
    schedules.push(schedule);
    this.save(schedules);
    return schedule;
  }
  remove(id: string): boolean {
    const schedules = this.list();
    const next = schedules.filter((schedule) => schedule.id !== id);
    if (next.length === schedules.length) return false;
    this.save(next);
    return true;
  }
}

export function validateTimezone(timezone: string): string {
  if (!timezone.trim()) throw new Error("Schedule timezone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Unknown schedule timezone '${timezone}'`);
  }
  return timezone;
}

/** Cron-parser accepts both five-field and six-field expressions. Loopy stores the user's expression verbatim. */
export function validateCronExpression(
  expression: string,
  timezone: string,
  now = new Date(),
): string {
  if (!expression.trim()) throw new Error("Schedule cron expression is required");
  validateTimezone(timezone);
  try {
    nextOccurrence(
      {
        schemaVersion: "1",
        scheduleId: "validation",
        expression: expression.trim(),
        timezone,
        enabled: true,
        overlap: "skip",
        missed: "skip",
        input: {},
      },
      now,
    );
  } catch (error) {
    throw new Error(
      `Invalid cron expression '${expression}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return expression.trim();
}

export function nextFireAt(expression: string, timezone: string, now = new Date()): string {
  validateCronExpression(expression, timezone, now);
  const value = nextOccurrence(
    {
      schemaVersion: "1",
      scheduleId: "next-fire",
      expression,
      timezone,
      enabled: true,
      overlap: "skip",
      missed: "skip",
      input: {},
    },
    now,
  ).toISOString();
  if (!value) throw new Error("Cron expression did not produce a next occurrence");
  return value;
}

export type CreateScheduleInput = {
  id?: string;
  name?: string;
  workflowId: string;
  workflowVersion?: number;
  input?: Record<string, unknown>;
  expression: string;
  timezone?: string;
  overlapPolicy?: ScheduleOverlapPolicy;
  missedPolicy?: ScheduleMissedPolicy;
  enabled?: boolean;
  now?: Date;
};

export function createSchedule(input: CreateScheduleInput): LocalSchedule {
  const now = input.now ?? new Date();
  const id = input.id?.trim() || randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id))
    throw new Error(
      "Schedule IDs must contain only letters, numbers, dots, underscores, or hyphens",
    );
  if (!input.workflowId.trim()) throw new Error("Schedule workflowId is required");
  const workflowVersion = input.workflowVersion ?? 1;
  if (!Number.isSafeInteger(workflowVersion) || workflowVersion < 1)
    throw new Error("Schedule workflowVersion must be a positive integer");
  const timezone = validateTimezone(
    input.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
  );
  const expression = validateCronExpression(input.expression, timezone, now);
  return {
    id,
    name: input.name?.trim() || id,
    workflowId: input.workflowId,
    workflowVersion,
    input: input.input ?? {},
    expression,
    timezone,
    overlapPolicy: input.overlapPolicy ?? "skip",
    missedPolicy: input.missedPolicy ?? "skip",
    enabled: input.enabled ?? true,
    nextFireAt: nextFireAt(expression, timezone, now),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function updateSchedule(
  schedule: LocalSchedule,
  patch: Partial<
    Pick<
      LocalSchedule,
      | "enabled"
      | "name"
      | "input"
      | "expression"
      | "timezone"
      | "overlapPolicy"
      | "missedPolicy"
      | "workflowId"
      | "workflowVersion"
    >
  >,
  now = new Date(),
): LocalSchedule {
  const merged = { ...schedule, ...patch };
  if (!merged.workflowId.trim()) throw new Error("Schedule workflowId is required");
  if (!Number.isSafeInteger(merged.workflowVersion) || merged.workflowVersion < 1)
    throw new Error("Schedule workflowVersion must be a positive integer");
  validateCronExpression(merged.expression, merged.timezone, now);
  return {
    ...merged,
    nextFireAt: nextFireAt(merged.expression, merged.timezone, now),
    updatedAt: now.toISOString(),
  };
}

export type ScheduleFireRequest = {
  scheduleId: string;
  workflowId: string;
  workflowVersion: number;
  input: Record<string, unknown>;
  scheduledAt: string;
};

export function fireSchedule(
  store: ScheduleStore,
  id: string,
  now = new Date(),
): ScheduleFireRequest {
  const schedule = store.get(id);
  if (!schedule) throw new Error(`Unknown schedule '${id}'`);
  if (!schedule.enabled) throw new Error(`Schedule '${id}' is disabled`);
  const scheduledAt = schedule.nextFireAt ?? now.toISOString();
  store.put({
    ...schedule,
    lastFireAt: now.toISOString(),
    nextFireAt: nextFireAt(schedule.expression, schedule.timezone, now),
    updatedAt: now.toISOString(),
  });
  return {
    scheduleId: id,
    workflowId: schedule.workflowId,
    workflowVersion: schedule.workflowVersion,
    input: schedule.input,
    scheduledAt,
  };
}

export type ScheduleTickResult = { due: ScheduleFireRequest[]; skipped: string[] };

export function tickSchedules(store: ScheduleStore, now = new Date()): ScheduleTickResult {
  const due: ScheduleFireRequest[] = [];
  const skipped: string[] = [];
  for (const schedule of store.list()) {
    if (
      !schedule.enabled ||
      !schedule.nextFireAt ||
      Date.parse(schedule.nextFireAt) > now.getTime()
    )
      continue;
    if (
      schedule.missedPolicy === "skip" &&
      Date.parse(schedule.nextFireAt) < now.getTime() - 60_000
    ) {
      skipped.push(schedule.id);
      store.put({
        ...schedule,
        nextFireAt: nextFireAt(schedule.expression, schedule.timezone, now),
        updatedAt: now.toISOString(),
      });
      continue;
    }
    due.push(fireSchedule(store, schedule.id, now));
  }
  return { due, skipped };
}

export type SchedulerPlatform = "darwin" | "linux";
export type SchedulerArtifact = {
  kind: "launchd" | "systemd-service" | "systemd-timer" | "cron";
  path: string;
  content: string;
  marker: string;
};

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function shell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function systemd(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll(" ", "\\x20")
    .replaceAll("\t", "\\x09");
}
function commandArgs(
  executable: string,
  projectDir: string,
  scheduleId?: string,
  entrypoint?: string,
): string[] {
  return [
    executable,
    ...(entrypoint ? [entrypoint] : []),
    "schedule",
    "tick",
    "--project",
    projectDir,
    ...(scheduleId ? ["--schedule", scheduleId] : []),
  ];
}
function safeLabel(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "-");
}

export function platformFor(value: string = process.platform): SchedulerPlatform {
  if (value === "darwin" || value === "linux") return value;
  throw new Error(
    `Unsupported platform '${value}'. Loopy scheduling supports macOS and Linux; Windows Task Scheduler is not implemented yet.`,
  );
}

export function renderSchedulerArtifacts(
  schedule: LocalSchedule,
  options: {
    executable: string;
    entrypoint?: string;
    projectDir: string;
    platform?: string;
    targetDir?: string;
  },
): SchedulerArtifact[] {
  const platform = platformFor(options.platform);
  const executable = resolve(options.executable);
  const projectDir = resolve(options.projectDir);
  const label = `dev.loopy.schedule.${safeLabel(schedule.id)}`;
  const marker = `loopy-managed:${schedule.id}`;
  const args = commandArgs(executable, projectDir, schedule.id, options.entrypoint);
  if (platform === "darwin") {
    const plist = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0"><dict>`,
      `<key>Label</key><string>${xml(label)}</string>`,
      `<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>`,
      `<key>StartInterval</key><integer>60</integer>`,
      `<key>RunAtLoad</key><false/>`,
      `<key>EnvironmentVariables</key><dict><key>LOOPY_SCHEDULE_ID</key><string>${xml(schedule.id)}</string><key>LOOPY_TIMEZONE</key><string>${xml(schedule.timezone)}</string></dict>`,
      `</dict></plist>`,
    ].join("");
    const targetDir = options.targetDir ?? join(homedir(), "Library", "LaunchAgents");
    return [
      { kind: "launchd", path: join(targetDir, `${label}.plist`), content: `${plist}\n`, marker },
    ];
  }
  const targetDir = options.targetDir ?? join(homedir(), ".config", "systemd", "user");
  const service = [
    `# ${marker}`,
    "[Unit]",
    `Description=Loopy schedule ${schedule.name}`,
    "[Service]",
    "Type=oneshot",
    `ExecStart=${args.map(systemd).join(" ")}`,
    `Environment=LOOPY_SCHEDULE_ID=${systemd(schedule.id)}`,
    `Environment=LOOPY_TIMEZONE=${systemd(schedule.timezone)}`,
    "",
  ].join("\n");
  const timer = [
    `# ${marker}`,
    "[Unit]",
    `Description=Loopy schedule timer ${schedule.name}`,
    "[Timer]",
    "OnBootSec=60s",
    "OnUnitActiveSec=60s",
    "AccuracySec=1s",
    "Persistent=true",
    `Unit=${label}.service`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  const cron = [
    `# ${marker}`,
    `CRON_TZ=${schedule.timezone}`,
    `* * * * * ${args.map(shell).join(" ")} # ${marker}`,
    "",
  ].join("\n");
  return [
    {
      kind: "systemd-service",
      path: join(targetDir, `${label}.service`),
      content: service,
      marker,
    },
    { kind: "systemd-timer", path: join(targetDir, `${label}.timer`), content: timer, marker },
    { kind: "cron", path: join(targetDir, `${label}.cron`), content: cron, marker },
  ];
}

export function installSchedulerArtifacts(
  artifacts: readonly SchedulerArtifact[],
): SchedulerArtifact[] {
  for (const artifact of artifacts) atomicWrite(artifact.path, artifact.content);
  return [...artifacts];
}

export function uninstallSchedulerArtifacts(artifacts: readonly SchedulerArtifact[]): string[] {
  const removed: string[] = [];
  for (const artifact of artifacts) {
    try {
      unlinkSync(artifact.path);
      removed.push(artifact.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}

export function schedulerArtifactPaths(
  schedule: LocalSchedule,
  options: {
    executable: string;
    entrypoint?: string;
    projectDir: string;
    platform?: string;
    targetDir?: string;
  },
): string[] {
  return renderSchedulerArtifacts(schedule, options).map((artifact) => artifact.path);
}
