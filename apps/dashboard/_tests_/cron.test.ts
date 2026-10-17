import { expect, test } from "bun:test";
import { describeCron } from "../src/lib/cron.ts";

test("common cron patterns read as plain sentences", () => {
  expect(describeCron("*/5 * * * *")).toBe("Every 5 minutes");
  expect(describeCron("0 */2 * * *")).toBe("Every 2 hours at :00");
  expect(describeCron("0 9 * * *")).toBe("Daily at 09:00");
  expect(describeCron("@hourly")).toBe("Every hour at :00");
  expect(describeCron("@weekly")).toBe("At 00:00 on Sunday");
  expect(describeCron("@monthly")).toBe("At 00:00 on day 1 of the month");
  expect(describeCron("@yearly")).toBe("At 00:00 on January 1");
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
    "*/0 * * * *",
    "0 */5 * * *",
    "30 */2 * * *",
    "5 * * * *",
    "* * * * *",
    "60 9 * * *",
    "0 24 * * *",
    "0 9 0 * *",
    "0 9 32 * *",
    "0 9 * * 8",
    "0 9 * * 5-1",
    "*/5 9 * * mon",
    "0 */2 1 * *",
  ]) {
    expect(describeCron(expression)).toBeUndefined();
  }
});

test.each(["99 25 * * *", "*/59 * * * *"])("%s has no exact plain reading", (expression) => {
  expect(describeCron(expression)).toBeUndefined();
});
