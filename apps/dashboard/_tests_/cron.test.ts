import { expect, test } from "bun:test";
import { describeCron } from "../src/lib/cron.ts";

test("common cron patterns read as plain sentences", () => {
  expect(describeCron("* * * * *")).toBe("Every minute");
  expect(describeCron("*/5 * * * *")).toBe("Every 5 minutes");
  expect(describeCron("5 * * * *")).toBe("Every hour at :05");
  expect(describeCron("30 */2 * * *")).toBe("Every 2 hours at :30");
  expect(describeCron("0 9 * * *")).toBe("Daily at 09:00");
  expect(describeCron("@daily")).toBe("Daily at 00:00");
  expect(describeCron("0 9 * * 1-5")).toBe("At 09:00 on Monday to Friday");
  expect(describeCron("0 9 * * mon,WED,7")).toBe("At 09:00 on Monday, Wednesday, and Sunday");
  expect(describeCron("15 6 1 * *")).toBe("At 06:15 on day 1 of the month");
});

test("rarer or malformed expressions have no reading", () => {
  for (const expression of [
    "0 9 * 1 *",
    "0 9 1 * 1",
    "1-5 * * * *",
    "0 9 * * 1-5-6",
    "0 9 * *",
    "nope",
  ]) {
    expect(describeCron(expression)).toBeUndefined();
  }
});
