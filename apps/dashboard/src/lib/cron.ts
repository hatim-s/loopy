const ALIASES = new Map([
  ["@hourly", "0 * * * *"],
  ["@daily", "0 0 * * *"],
  ["@weekly", "0 0 * * 0"],
  ["@monthly", "0 0 1 * *"],
  ["@yearly", "0 0 1 1 *"],
]);

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const NUMBER = /^\d+$/u;

const STEP = /^\*\/(\d+)$/u;

const pad = (value: string) => value.padStart(2, "0");

/** Cron allows 7 for Sunday as well as 0. */
function weekday(text: string): string | undefined {
  return NUMBER.test(text) ? DAYS[Number(text) % 7] : DAYS[DAY_NAMES.indexOf(text.toLowerCase())];
}

function dayRange(token: string): string | undefined {
  const [from = "", to = from, ...rest] = token.split("-");
  const first = weekday(from);
  const last = weekday(to);

  if (rest.length > 0 || first === undefined || last === undefined) {
    return undefined;
  }

  return first === last ? first : `${first} to ${last}`;
}

function days(dayOfMonth: string, dayOfWeek: string): string | undefined {
  if (dayOfMonth !== "*") {
    return dayOfWeek === "*" && NUMBER.test(dayOfMonth)
      ? `day ${dayOfMonth} of the month`
      : undefined;
  }

  const parts = dayOfWeek.split(",").map(dayRange);

  return parts.every((part): part is string => part !== undefined)
    ? new Intl.ListFormat("en").format(parts)
    : undefined;
}

/** Minute and hour patterns, first match wins. */
function clock(minute: string, hour: string): string | undefined {
  const minuteStep = STEP.exec(minute)?.[1];
  const hourStep = STEP.exec(hour)?.[1];
  const exact = NUMBER.test(minute);

  const readings: [boolean, string][] = [
    [minute === "*" && hour === "*", "Every minute"],
    [minuteStep !== undefined && hour === "*", `Every ${minuteStep} minutes`],
    [exact && hour === "*", `Every hour at :${pad(minute)}`],
    [exact && hourStep !== undefined, `Every ${hourStep} hours at :${pad(minute)}`],
    [exact && NUMBER.test(hour), `At ${pad(hour)}:${pad(minute)}`],
  ];

  return readings.find(([matches]) => matches)?.[1];
}

/**
 * A plain reading of the common cron patterns: "Every 5 minutes", "At 09:00 on Monday to
 * Friday". Rarer expressions read as undefined and the expression speaks for itself.
 */
export function describeCron(expression: string): string | undefined {
  const fields = (ALIASES.get(expression.trim()) ?? expression).trim().split(/\s+/u);
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  const when = clock(minute, hour);

  if (fields.length !== 5 || month !== "*" || when === undefined) {
    return undefined;
  }

  if (dayOfMonth === "*" && dayOfWeek === "*") {
    return when.startsWith("At ") ? `Daily at ${when.slice(3)}` : when;
  }

  const on = days(dayOfMonth, dayOfWeek);

  return on === undefined ? undefined : `${when} on ${on}`;
}
