import { describe, expect, test } from "bun:test";
import { nextFire, parseCron } from "../src/host/index.js";

function next(expression: string, after: string, zone = "UTC") {
  return nextFire(parseCron(expression), new Date(after), zone).toISOString();
}

describe("parseCron", () => {
  test("parses wildcards, lists, ranges and steps", () => {
    const schedule = parseCron("*/15 1,3,5 1-30/5 * 1-5");
    expect([...schedule.minute.values]).toEqual([0, 15, 30, 45]);
    expect([...schedule.hour.values]).toEqual([1, 3, 5]);
    expect([...schedule.dayOfMonth.values]).toEqual([1, 6, 11, 16, 21, 26]);
    expect(schedule.month.values.size).toBe(12);
    expect([...schedule.dayOfWeek.values]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("5/20 * * * *").minute.values]).toEqual([5, 25, 45]);
  });
  test("parses names and both Sunday numbers", () => {
    const schedule = parseCron("0 0 * JAN-mar,dec SUN-tue,7");
    expect([...schedule.month.values]).toEqual([1, 2, 3, 12]);
    expect([...schedule.dayOfWeek.values]).toEqual([0, 1, 2]);
    expect(next("0 0 * * 7", "2026-01-03T00:00:00Z")).toBe("2026-01-04T00:00:00.000Z");
  });
  test.each([
    ["@hourly", "0 * * * *"],
    ["@daily", "0 0 * * *"],
    ["@weekly", "0 0 * * 0"],
    ["@monthly", "0 0 1 * *"],
    ["@yearly", "0 0 1 1 *"],
  ])("expands %s", (alias, expression) => {
    expect(parseCron(alias)).toEqual(parseCron(expression));
  });
  test.each([
    ["60 * * * *", "minute", "60"],
    ["* 24 * * *", "hour", "24"],
    ["* * 0 * *", "day-of-month", "0"],
    ["* * * wat *", "month", "wat"],
    ["* * * * 8", "day-of-week", "8"],
    ["*/0 * * * *", "minute", "*/0"],
    ["1-0 * * * *", "minute", "1-0"],
    ["1,,2 * * * *", "minute", ""],
    ["*/1/2 * * * *", "minute", "*/1/2"],
    ["1-2-3 * * * *", "minute", "1-2-3"],
    ["*/1.5 * * * *", "minute", "*/1.5"],
    ["* * * * mon-fry", "day-of-week", "mon-fry"],
  ])("rejects %s with field and token", (expression, field, token) => {
    expect(() => parseCron(expression)).toThrow(
      `Invalid ${field} token '${token}'. Use a value, list, ascending range, or positive step within`,
    );
  });
  test.each(["", "* * * *", "* * * * * *", "@unknown"])(
    "rejects malformed expression %s",
    (expression) => {
      expect(() => parseCron(expression)).toThrow(
        `Invalid cron expression '${expression}'. Provide five fields:`,
      );
    },
  );
});

describe("nextFire", () => {
  test("is strictly after the input and crosses month boundaries", () => {
    expect(next("* * * * *", "2026-01-31T23:59:30Z")).toBe("2026-02-01T00:00:00.000Z");
    expect(next("0 0 1 * *", "2026-01-01T00:00:00Z")).toBe("2026-02-01T00:00:00.000Z");
  });
  test("uses the Kolkata half-hour offset", () => {
    expect(next("0 9 * * *", "2026-01-01T00:00:00Z", "Asia/Kolkata")).toBe(
      "2026-01-01T03:30:00.000Z",
    );
  });
  test.each([
    ["Pacific/Chatham", "50 3 * * *", "2026-09-26T13:40:00Z", "2026-09-26T14:05:00.000Z"],
    ["Australia/Lord_Howe", "40 2 * * *", "2026-10-03T15:20:00Z", "2026-10-03T15:40:00.000Z"],
  ])(
    "finds valid minutes after a partial-hour spring gap in %s",
    (zone, expression, after, expected) => {
      expect(next(expression, after, zone)).toBe(expected);
    },
  );
  test.each([
    ["America/New_York", "30 2 * * *", "2026-03-08T05:00:00Z", "2026-03-09T06:30:00.000Z"],
    ["Europe/London", "30 1 * * *", "2026-03-29T00:00:00Z", "2026-03-30T00:30:00.000Z"],
    ["Australia/Lord_Howe", "10 2 * * *", "2026-10-03T15:20:00Z", "2026-10-04T15:10:00.000Z"],
  ])("skips the spring gap in %s", (zone, expression, after, expected) => {
    expect(next(expression, after, zone)).toBe(expected);
  });
  test.each([
    [
      "America/New_York",
      "2026-11-01T04:00:00Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ],
    [
      "Europe/London",
      "2026-10-25T00:00:00Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
    ],
  ])("fires only the first overlapping minute in %s", (zone, after, first, following) => {
    expect(next("30 1 * * *", after, zone)).toBe(first);
    expect(next("30 1 * * *", first, zone)).toBe(following);
    expect(next("30 1 * * *", new Date(Date.parse(first) + 15 * 60_000).toISOString(), zone)).toBe(
      following,
    );
  });
  test("fires only the first minute of the Lord Howe half-hour overlap", () => {
    expect(next("45 1 * * *", "2026-04-04T14:00:00Z", "Australia/Lord_Howe")).toBe(
      "2026-04-04T14:45:00.000Z",
    );
    expect(next("45 1 * * *", "2026-04-04T14:45:00Z", "Australia/Lord_Howe")).toBe(
      "2026-04-05T15:15:00.000Z",
    );
    expect(next("45 1 * * *", "2026-04-04T15:00:00Z", "Australia/Lord_Howe")).toBe(
      "2026-04-05T15:15:00.000Z",
    );
  });
  test("combines restricted days with OR and wildcard days with AND", () => {
    expect(next("0 0 13 * mon", "2026-01-11T00:00:00Z")).toBe("2026-01-12T00:00:00.000Z");
    expect(next("0 0 13 * mon", "2026-01-12T00:00:00Z")).toBe("2026-01-13T00:00:00.000Z");
    expect(next("0 0 * * mon", "2026-01-12T00:00:00Z")).toBe("2026-01-19T00:00:00.000Z");
    expect(next("0 0 13 * *", "2026-01-13T00:00:00Z")).toBe("2026-02-13T00:00:00.000Z");
    expect(next("0 0 */2 * mon", "2026-01-11T00:00:00Z")).toBe("2026-01-19T00:00:00.000Z");
  });
  test("bounds an impossible calendar search", () => {
    expect(() => next("0 0 31 feb *", "2026-01-01T00:00:00Z")).toThrow(
      "No cron fire found within five years. Choose a schedule with a reachable calendar date.",
    );
  });
  test("rejects invalid dates and zones", () => {
    expect(() => nextFire(parseCron("* * * * *"), new Date(Number.NaN), "UTC")).toThrow(
      "Invalid after date.",
    );
    expect(() => next("* * * * *", "2026-01-01T00:00:00Z", "invalid/zone")).toThrow(
      "Invalid time zone 'invalid/zone'.",
    );
  });
});
