import { parseCron, zoneFormatter } from "./cron";

export function validateTimeZone(timeZone: string): void {
  zoneFormatter(timeZone);
}

export function validateSchedule(schedule: { cron: string; tz: string }): void {
  parseCron(schedule.cron);
  validateTimeZone(schedule.tz);
}
