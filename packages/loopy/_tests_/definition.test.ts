import { expect, test } from "bun:test";
import { loopy } from "@loopy/sdk/graph";

test("graph definitions validate names, modes, scopes, schedules, secrets and input schemas for JavaScript callers", () => {
  expect(() => loopy("Bad name", { input: {}, run: () => null })).toThrow(
    "A slug must contain 1-80",
  );
  // @ts-expect-error JavaScript can supply an invalid mode.
  expect(() => loopy("test", { input: {}, mode: "unsafe", run: () => null })).toThrow(
    'Expected "sandbox" | "full"\n  at ["mode"]',
  );
  // @ts-expect-error JavaScript can supply an invalid scope.
  expect(() => loopy("test", { input: {}, scope: "remote", run: () => null })).toThrow(
    'Expected "project" | "global"\n  at ["scope"]',
  );
  // @ts-expect-error JavaScript can supply a malformed schedule.
  expect(() => loopy("test", { input: {}, schedule: { cron: 42 }, run: () => null })).toThrow(
    'Expected string\n  at ["schedule"]["cron"]',
  );
  // @ts-expect-error JavaScript can supply malformed secret names.
  expect(() => loopy("test", { input: {}, secrets: [42], run: () => null })).toThrow(
    'Expected string\n  at ["secrets"][0]',
  );
  // @ts-expect-error JavaScript can supply a non-object schema.
  expect(() => loopy("test", { input: 42, run: () => null })).toThrow(
    'Expected object\n  at ["input"]',
  );
  // @ts-expect-error JavaScript can supply unknown field types.
  expect(() => loopy("test", { input: { count: "integer" }, run: () => null })).toThrow(
    '  at ["input"]["count"]',
  );
});

test("normalized graph metadata and schema do not retain caller-owned arrays or records", () => {
  const input = { "limit?": "number" } as const;
  const secrets = ["TOKEN"];
  const schedule = { cron: "0 * * * *" };
  const graph = loopy("test", { input, secrets, schedule, run: ({ input }) => input });
  expect(graph.meta).toEqual({
    description: null,
    mode: "sandbox",
    scope: "project",
    secrets: ["TOKEN"],
    schedule: { cron: "0 * * * *", tz: "UTC" },
  });
  secrets.push("OTHER");
  schedule.cron = "* * * * *";
  expect(graph.meta.secrets).toEqual(["TOKEN"]);
  expect(graph.meta.schedule?.cron).toBe("0 * * * *");
  expect(graph.input).toEqual(input);
});

for (const cron of ["* * * *", "60 * * * *", "*/0 * * * *", "0 0 * wat *"]) {
  test(`graph definition rejects invalid cron ${cron}`, () => {
    expect(() => loopy("test", { input: {}, schedule: { cron }, run: () => null })).toThrow(
      "Invalid",
    );
  });
}

test("graph definitions validate timezones and reject unknown properties", () => {
  expect(() =>
    loopy("test", { input: {}, schedule: { cron: "@daily", tz: "Mars/Olympus" }, run: () => null }),
  ).toThrow("Invalid time zone 'Mars/Olympus'");
  // @ts-expect-error JavaScript callers can pass unknown properties.
  expect(() => loopy("test", { input: {}, typo: true, run: () => null })).toThrow(
    'Expected no excess property\n  at ["typo"]',
  );
  expect(() =>
    // @ts-expect-error JavaScript callers can pass unknown schedule properties.
    loopy("test", { input: {}, schedule: { cron: "@daily", timezone: "UTC" }, run: () => null }),
  ).toThrow('Expected no excess property\n  at ["schedule"]["timezone"]');
  expect(
    loopy("test", { input: {}, schedule: { cron: "@daily", tz: "Asia/Kolkata" }, run: () => null })
      .meta.schedule,
  ).toEqual({ cron: "@daily", tz: "Asia/Kolkata" });
});
