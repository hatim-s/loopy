const ALIASES = new Map([
  ["@hourly", "Every hour at :00"],
  ["@daily", "Daily at 00:00"],
  ["@weekly", "At 00:00 on Sunday"],
  ["@monthly", "At 00:00 on day 1 of the month"],
  ["@yearly", "At 00:00 on January 1"],
]);

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const NUMBER = /^\d+$/u;

const STEP = /^\*\/(\d+)$/u;

const pad = (value: string) => String(Number(value)).padStart(2, "0");

function bounded(text: string, min: number, max: number): boolean {
  return NUMBER.test(text) && Number(text) >= min && Number(text) <= max;
}

function weekday(text: string): number | undefined {
  const named = DAY_NAMES.indexOf(text.toLowerCase());

  if (named >= 0) {
    return named;
  }

  return bounded(text, 0, 7) ? Number(text) : undefined;
}

function dayRange(token: string): string | undefined {
  const [from = "", to = from, ...rest] = token.split("-");
  const first = weekday(from);
  const last = weekday(to);

  if (rest.length > 0 || first === undefined || last === undefined || first > last) {
    return undefined;
  }

  if (first === 0 && last === 7) {
    return "Sunday to Saturday";
  }

  return first === last ? DAYS[first % 7] : `${DAYS[first % 7]} to ${DAYS[last % 7]}`;
}

function days(dayOfMonth: string, dayOfWeek: string): string | undefined {
  if (dayOfMonth !== "*") {
    return dayOfWeek === "*" && bounded(dayOfMonth, 1, 31)
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

  return step !== undefined && Number(step) > 0 && cycle % Number(step) === 0
    ? String(Number(step))
    : undefined;
}

/** Only uniform intervals get an interval reading; cron steps restart at each boundary. */
function recurring(minute: string, hour: string): string | undefined {
  const minutes = interval(minute, 60);
  const hours = interval(hour, 24);

  if (minutes !== undefined && hour === "*") {
    return `Every ${minutes} minutes`;
  }

  return minute === "0" && hours !== undefined ? `Every ${hours} hours at :00` : undefined;
}

/** Unsupported expressions keep their literal spelling instead of a misleading reading. */
export function describeCron(expression: string): string | undefined {
  const trimmed = expression.trim();
  const alias = ALIASES.get(trimmed.toLowerCase());

  if (alias !== undefined) {
    return alias;
  }

  const fields = trimmed.split(/\s+/u);
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;

  if (fields.length !== 5 || month !== "*") {
    return undefined;
  }

  if (dayOfMonth === "*" && dayOfWeek === "*") {
    return bounded(minute, 0, 59) && bounded(hour, 0, 23)
      ? `Daily at ${pad(hour)}:${pad(minute)}`
      : recurring(minute, hour);
  }

  const on = days(dayOfMonth, dayOfWeek);

  return bounded(minute, 0, 59) && bounded(hour, 0, 23) && on !== undefined
    ? `At ${pad(hour)}:${pad(minute)} on ${on}`
    : undefined;
}
