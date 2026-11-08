import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  FAILURE_JOURNEY_SOURCES,
  SQL_PROBE_SOURCES,
  sourceFiles,
  TRANSPORT_FAILURE_SOURCES,
} from "../../../dev/shared/sources";

const root = resolve(import.meta.dir, "../../../../..");

test("every evidence source list still names files in the repository", async () => {
  for (const patterns of [TRANSPORT_FAILURE_SOURCES, FAILURE_JOURNEY_SOURCES, SQL_PROBE_SOURCES]) {
    const files = await sourceFiles(root, patterns);
    expect(files.length).toBeGreaterThanOrEqual(patterns.length);

    for (const file of files) {
      expect(await Bun.file(resolve(root, file)).exists()).toBe(true);
    }
  }

  await expect(sourceFiles(root, ["packages/contract/src/sandbox.ts"])).rejects.toThrow(
    "matches no file",
  );
});
