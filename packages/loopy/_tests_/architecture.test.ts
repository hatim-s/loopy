import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("authoring, runtime and cloud exports bundle without host dependencies", async () => {
  const result = await Bun.build({
    entrypoints: ["core", "runtime", "cloud"].map((name) =>
      resolve(import.meta.dir, `../src/${name}/index.ts`),
    ),
    target: "browser",
  });
  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
});
