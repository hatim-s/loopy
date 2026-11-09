type CronField = { values: ReadonlySet<number>; restricted: boolean };

type CronSchedule = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");

export const CRON_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export const CRON_ALIASES = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
} as const;

export type CronAlias = keyof typeof CRON_ALIASES;

export function cronAlias(expression: string): CronAlias | undefined {
  const name = expression.trim().toLowerCase();

  return Object.keys(CRON_ALIASES).find((alias): alias is CronAlias => alias === name);
}

const MINUTE_MS = 60_000;

const DAY_MS = 86_400_000;

type FieldSpec = { name: string; min: number; max: number; names: string[] };

function invalid(spec: FieldSpec, token: string): never {
  throw new Error(
    `Invalid ${spec.name} token '${token}'. Use a value, list, ascending range, or positive step within ${spec.min}-${spec.max}.`,
  );
}

function fieldValue(text: string, spec: FieldSpec, token: string): number {
  const named = spec.names.indexOf(text.toLowerCase());
  const value = named >= 0 ? named + spec.min : Number(text);

  if (
    (named < 0 && !/^\d+$/u.test(text)) ||
    !Number.isInteger(value) ||
    value < spec.min ||
    value > spec.max
  ) {
    invalid(spec, token);
  }

  return value;
}

function tokenValues(token: string, spec: FieldSpec): number[] {
  const [base = "", stepText, extra] = token.split("/");
  const step = stepText === undefined ? 1 : Number(stepText);

  if (
    extra !== undefined ||
    (stepText !== undefined && !/^\d+$/u.test(stepText)) ||
    !Number.isSafeInteger(step) ||
    step < 1
  ) {
    invalid(spec, token);
  }

  const bounds = base.split("-");
  const start = base === "*" ? spec.min : fieldValue(bounds[0] ?? "", spec, token);
  let end = start;

  if (base === "*" || (bounds.length === 1 && stepText !== undefined)) {
    end = spec.max;
  }

  if (bounds.length === 2) {
    end = fieldValue(bounds[1] ?? "", spec, token);
  }

  if (bounds.length > 2 || start > end) {
    invalid(spec, token);
  }

  const values: number[] = [];

  for (let value = start; value <= end; value += step) {
    values.push(spec.name === "day-of-week" ? value % 7 : value);
  }

  return values;
}

function parseField(text: string, spec: FieldSpec): CronField {
  return {
    values: new Set(text.split(",").flatMap((token) => tokenValues(token, spec))),
    restricted: !text.startsWith("*"),
  };
}

/** The five raw fields of an expression, with an alias expanded. */
export function cronFields(expression: string) {
  const alias = cronAlias(expression);
  const expanded = alias === undefined ? expression : CRON_ALIASES[alias];
  const fields = expanded.trim().split(/\s+/u);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  if (fields.length !== 5 || !minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    throw new Error(
      `Invalid cron expression '${expression}'. Provide five fields: minute hour day-of-month month day-of-week, or a supported alias.`,
    );
  }

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export function parseCron(expression: string): CronSchedule {
  const { minute, hour, dayOfMonth, month, dayOfWeek } = cronFields(expression);

  return {
    minute: parseField(minute, { name: "minute", min: 0, max: 59, names: [] }),
    hour: parseField(hour, { name: "hour", min: 0, max: 23, names: [] }),
    dayOfMonth: parseField(dayOfMonth, { name: "day-of-month", min: 1, max: 31, names: [] }),
    month: parseField(month, { name: "month", min: 1, max: 12, names: MONTHS }),
    dayOfWeek: parseField(dayOfWeek, {
      name: "day-of-week",
      min: 0,
      max: 7,
      names: CRON_WEEKDAYS,
    }),
  };
}

function wallTime(formatter: Intl.DateTimeFormat, timestamp: number): Date {
  const parts = formatter.formatToParts(timestamp);
  const value = (name: string) => Number(parts.find((part) => part.type === name)?.value);

  return new Date(
    Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute")),
  );
}

function matchesDay(schedule: CronSchedule, wall: Date): boolean {
  const dom = schedule.dayOfMonth.values.has(wall.getUTCDate());
  const dow = schedule.dayOfWeek.values.has(wall.getUTCDay());

  if (schedule.dayOfMonth.restricted && schedule.dayOfWeek.restricted) {
    return dom || dow;
  }

  return dom && dow;
}

function resolveWallTime(formatter: Intl.DateTimeFormat, candidate: number): number | null {
  let first: number | null = null;

  // Sample both sides of a transition, then verify each possible offset against Intl.
  for (const delta of [-DAY_MS, 0, DAY_MS]) {
    const sample = candidate + delta;
    const offset = wallTime(formatter, sample).getTime() - sample;
    const timestamp = candidate - offset;

    if (wallTime(formatter, timestamp).getTime() !== candidate) {
      continue;
    }

    if (first === null || timestamp < first) {
      first = timestamp;
    }
  }

  return first;
}

function* calendarCandidates(schedule: CronSchedule, start: Date, end: Date) {
  const day = new Date(start);
  day.setUTCHours(0, 0, 0, 0);
  const hours = [...schedule.hour.values].sort((left, right) => left - right);
  const minutes = [...schedule.minute.values].sort((left, right) => left - right);

  for (; day.getTime() <= end.getTime(); day.setUTCDate(day.getUTCDate() + 1)) {
    if (!schedule.month.values.has(day.getUTCMonth() + 1) || !matchesDay(schedule, day)) {
      continue;
    }

    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = day.getTime() + (hour * 60 + minute) * MINUTE_MS;

        if (candidate >= start.getTime() && candidate <= end.getTime()) {
          yield candidate;
        }
      }
    }
  }
}

export function zoneFormatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone });
  } catch {
    throw new Error(
      `Invalid time zone '${timeZone}'. Provide an IANA time zone such as 'Asia/Kolkata'.`,
    );
  }
}

export function nextFire(expression: string, after: Date, timeZone: string): Date {
  const schedule = parseCron(expression);

  if (!Number.isFinite(after.getTime())) {
    throw new Error("Invalid after date. Provide a valid Date to find the next cron fire.");
  }

  const formatter = zoneFormatter(timeZone, {
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const limit = new Date(after);
  limit.setUTCFullYear(limit.getUTCFullYear() + 5);

  const start = wallTime(formatter, after.getTime());
  const end = wallTime(formatter, limit.getTime());

  for (const candidate of calendarCandidates(schedule, start, end)) {
    const timestamp = resolveWallTime(formatter, candidate);

    if (timestamp !== null && timestamp > after.getTime() && timestamp <= limit.getTime()) {
      return new Date(timestamp);
    }
  }

  throw new Error(
    "No cron fire found within five years. Choose a schedule with a reachable calendar date.",
  );
}
