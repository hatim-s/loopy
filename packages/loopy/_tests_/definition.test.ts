import { expect, test } from "bun:test";
import { code, loopy } from "../src/sdk/index.js";

function rejects(build: () => void, expected: string) {
  expect(build).toThrow(
    expect.objectContaining({ diagnostic: expect.objectContaining({ code: expected }) }),
  );
}

test("graph definitions validate names, modes, scopes, schedules, secrets and schemas for JavaScript callers", () => {
  rejects(() => loopy("Bad name", { input: {}, run: () => null }), "invalid_definition");
  rejects(
    // @ts-expect-error JavaScript can supply an invalid mode.
    () => loopy("test", { input: {}, mode: "unsafe", run: () => null }),
    "invalid_definition",
  );
  rejects(
    // @ts-expect-error JavaScript can supply an invalid scope.
    () => loopy("test", { input: {}, scope: "remote", run: () => null }),
    "invalid_definition",
  );
  rejects(
    // @ts-expect-error JavaScript can supply a non-string description.
    () => loopy("test", { input: {}, description: 1, run: () => null }),
    "invalid_definition",
  );
  rejects(
    // @ts-expect-error JavaScript can supply a malformed schedule.
    () => loopy("test", { input: {}, schedule: { cron: 42 }, run: () => null }),
    "invalid_schedule",
  );
  // @ts-expect-error JavaScript can supply malformed secret names.
  rejects(() => loopy("test", { input: {}, secrets: [42], run: () => null }), "invalid_secret");
  // @ts-expect-error JavaScript can supply a non-object schema.
  rejects(() => loopy("test", { input: 42, run: () => null }), "invalid_schema");
  // @ts-expect-error JavaScript can supply unknown field types.
  rejects(() => loopy("test", { input: { count: "integer" }, run: () => null }), "invalid_schema");
  rejects(
    () =>
      loopy("test", {
        input: {},
        // @ts-expect-error JavaScript can supply an unknown output type.
        run: () => code("bad", { in: {}, out: "strng", module: "./m.ts" }),
      }),
    "invalid_schema",
  );
});

test("normalized graph metadata and schema do not retain caller-owned arrays or records", () => {
  const input = { "limit?": "number" } as const;
  const secrets = ["TOKEN"];
  const schedule = { cron: "0 * * * *" };
  const { graph } = loopy("test", { input, secrets, schedule, run: ({ input }) => input });
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
      expect.objectContaining({
        diagnostic: expect.objectContaining({ code: "invalid_schedule" }),
      }),
    );
  });
}

test("graph definitions validate timezones and reject unknown properties", () => {
  expect(() =>
    loopy("test", { input: {}, schedule: { cron: "@daily", tz: "Mars/Olympus" }, run: () => null }),
  ).toThrow(
    expect.objectContaining({ diagnostic: expect.objectContaining({ code: "invalid_schedule" }) }),
  );
  // @ts-expect-error JavaScript callers can pass unknown properties.
  expect(() => loopy("test", { input: {}, typo: true, run: () => null })).toThrow(
    expect.objectContaining({ diagnostic: expect.objectContaining({ code: "unknown_property" }) }),
  );
  expect(() =>
    // @ts-expect-error JavaScript callers can pass unknown schedule properties.
    loopy("test", { input: {}, schedule: { cron: "@daily", timezone: "UTC" }, run: () => null }),
  ).toThrow(
    expect.objectContaining({ diagnostic: expect.objectContaining({ code: "unknown_property" }) }),
  );
  expect(
    loopy("test", { input: {}, schedule: { cron: "@daily", tz: "Asia/Kolkata" }, run: () => null })
      .graph.meta.schedule,
  ).toEqual({ cron: "@daily", tz: "Asia/Kolkata" });
});
