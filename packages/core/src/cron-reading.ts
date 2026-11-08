import { CRON_WEEKDAYS, type CronAlias, cronAlias, parseCron } from "./cron";

const ALIAS_READINGS = {
  "@hourly": "Every hour at :00",
  "@daily": "Daily at 00:00",
  "@weekly": "At 00:00 on Sunday",
  "@monthly": "At 00:00 on day 1 of the month",
  "@yearly": "At 00:00 on January 1",
} satisfies Record<CronAlias, string>;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const NUMBER = /^\d+$/u;

const STEP = /^\*\/(\d+)$/u;

const pad = (value: string) => String(Number(value)).padStart(2, "0");

function weekday(text: string): number {
  const named = CRON_WEEKDAYS.indexOf(text.toLowerCase());

  return named >= 0 ? named : Number(text);
}

function dayRange(token: string): string | undefined {
  const [from = "", to = from, ...rest] = token.split("-");

  if (rest.length > 0 || token.includes("/")) {
    return undefined;
  }

  const first = weekday(from);
  const last = weekday(to);

  if (first === 0 && last === 7) {
    return "Sunday to Saturday";
  }

  return first === last ? DAYS[first % 7] : `${DAYS[first % 7]} to ${DAYS[last % 7]}`;
}

function days(dayOfMonth: string, dayOfWeek: string): string | undefined {
  if (dayOfMonth !== "*") {
    return dayOfWeek === "*" && NUMBER.test(dayOfMonth)
      ? `day ${Number(dayOfMonth)} of the month`
      : undefined;
  }

  const parts = dayOfWeek.split(",").map(dayRange);

  return parts.every((part): part is string => part !== undefined)
    ? new Intl.ListFormat("en").format(parts)
    : undefined;
}

function interval(token: string, cycle: number): string | undefined {
  const step = STEP.exec(token)?.[1];

  return step !== undefined && cycle % Number(step) === 0 ? String(Number(step)) : undefined;
}

// Only uniform intervals get an interval reading; cron steps restart at each boundary.
function recurring(minute: string, hour: string): string | undefined {
  const minutes = interval(minute, 60);
  const hours = interval(hour, 24);

  if (minutes !== undefined && hour === "*") {
    return `Every ${minutes} minutes`;
  }

  return minute === "0" && hours !== undefined ? `Every ${hours} hours at :00` : undefined;
}

/** A plain sentence for common schedules; anything else keeps its literal spelling. */
export function describeCron(expression: string): string | undefined {
  const alias = cronAlias(expression);

  if (alias !== undefined) {
    return ALIAS_READINGS[alias];
  }

  try {
    parseCron(expression);
  } catch {
    return undefined;
  }

  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = expression
    .trim()
    .split(/\s+/u);

  if (month !== "*") {
    return undefined;
  }

  const at = NUMBER.test(minute) && NUMBER.test(hour) ? `${pad(hour)}:${pad(minute)}` : undefined;

  if (dayOfMonth === "*" && dayOfWeek === "*") {
    return at === undefined ? recurring(minute, hour) : `Daily at ${at}`;
  }

  const on = days(dayOfMonth, dayOfWeek);

  return at !== undefined && on !== undefined ? `At ${at} on ${on}` : undefined;
}
