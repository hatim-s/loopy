import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { storageOperation } from "../operation";
import { BunSqlDriver } from "./bun-driver";
import { localOwnerPolicy } from "./local-owner";
import { SqlRunStore } from "./run-store";
import { upgradeLegacyHome } from "./schema/legacy";

type LocalOptions = { leaseMs?: number };

export const makeSqliteRunStore = (file: string, options: LocalOptions = {}) =>
  Effect.acquireRelease(
    storageOperation("open", () => {
      const driver = new BunSqlDriver(file);

      try {
        driver.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
        upgradeLegacyHome(driver);

        return new SqlRunStore(driver, { ...options, owner: localOwnerPolicy() });
      } catch (error) {
        driver.close();
        throw error;
      }
    }),
    (store) => store.close().pipe(Effect.orDie),
  );

export function openRunStore(home: string, options: LocalOptions = {}) {
  return Effect.gen(function* () {
    yield* storageOperation("prepareHome", () => mkdirSync(home, { recursive: true, mode: 0o700 }));

    return yield* makeSqliteRunStore(join(home, "runs.sqlite"), options);
  });
}
