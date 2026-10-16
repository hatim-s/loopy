import { expect, expectTypeOf, test } from "bun:test";
import { map, parallel, race } from "../src/runtime/index.js";
import { delay } from "./engine-fixture.js";

test("parallel and race infer heterogeneous tuple results", async () => {
  const fns = [async () => "a", async () => 1] as const;
  const values = parallel([async () => "a", async () => 1]);
  expectTypeOf(values).toEqualTypeOf<Promise<[string, number]>>();
  expectTypeOf(race(fns)).toEqualTypeOf<Promise<string | number>>();
  expect(await values).toEqual(["a", 1]);
});

test("map stops scheduling new items after its first rejection", async () => {
  const started: number[] = [];
  await expect(
    map(
      [0, 1, 2, 3],
      async (item) => {
        started.push(item);

        if (item === 0) {
          throw new Error("Item failed. Fix the item.");
        }

        await delay(10);

        return item;
      },
      { concurrency: 2 },
    ),
  ).rejects.toThrow("Item failed.");
  await delay(20);
  expect(started).toEqual([0, 1]);
});
