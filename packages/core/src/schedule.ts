import { parseCron } from "./cron";

export function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error(
      `Invalid time zone '${timeZone}'. Provide an IANA time zone such as 'Asia/Kolkata'.`,
    );
  }
}

export function validateSchedule(schedule: { cron: string; tz: string }): void {
  parseCron(schedule.cron);
  validateTimeZone(schedule.tz);
}
