import { expect, test } from "bun:test";
import { hookInput } from "../src/lib/hook-input.ts";

test("step input of another shape is not a hook input", () => {
  expect(hookInput(null)).toBeNull();
  expect(hookInput({ name: "approve" })).toBeNull();
  expect(hookInput({ name: "approve", token: "t", timeout: "1h" })).toBeNull();
});
