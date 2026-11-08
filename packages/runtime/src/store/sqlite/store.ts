import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "@loopy/core";
import { Effect } from "effect";
import { storageOperation } from "../operation";
import { BunSqlDriver } from "./bun-driver";
import { localOwnerPolicy } from "./local-owner";
import { SqlRunStore } from "./run-store";
import { upgradeLegacyHome } from "./schema/legacy";

type LocalOptions = { leaseMs?: number };

// Tests and tools may write the same home from another connection. Those commits never reach this
// connection's outbox, so a data_version change tells listeners to re-read storage.
const EXTERNAL_WRITE_POLL_MS = 100;

class LocalSqlStore extends SqlRunStore {
  private poll?: ReturnType<typeof setInterval>;
  private version = 0;

  constructor(
    private readonly driver: BunSqlDriver,
    options: LocalOptions,
  ) {
    driver.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    upgradeLegacyHome(driver);
    super(driver, { ...options, owner: localOwnerPolicy() });
  }

  override subscribe(listener: (events: RuntimeEvent[]) => void): () => void {
    const unsubscribe = super.subscribe(listener);

    if (!this.poll) {
      this.version = this.dataVersion();
      this.poll = setInterval(() => this.notifyExternalWrites(), EXTERNAL_WRITE_POLL_MS);
    }

    return () => {
      unsubscribe();

      if (this.listeners.size === 0) {
        this.stopPolling();
      }
    };
  }

  override close() {
    this.stopPolling();

    return super.close();
  }

  private dataVersion(): number {
    return (
      this.driver.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ??
      0
    );
  }

  private notifyExternalWrites(): void {
    let version: number;

    try {
      version = this.dataVersion();
    } catch {
      // One notification lets each listener's next read report the failure with its cause.
      this.stopPolling();
      this.listeners.notify();

      return;
    }

    if (version !== this.version) {
      this.version = version;
      this.listeners.notify();
    }
  }

  private stopPolling(): void {
    clearInterval(this.poll);
    this.poll = undefined;
  }
}

export type SqliteRunStore = LocalSqlStore;

export const makeSqliteRunStore = (file: string, options: LocalOptions = {}) =>
  Effect.acquireRelease(
    storageOperation("open", () => {
      const driver = new BunSqlDriver(file);

      try {
        return new LocalSqlStore(driver, options);
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
