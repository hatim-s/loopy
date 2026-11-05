import { Effect } from "effect";
import { openRunStore, type SqliteRunStore } from "../local/index.js";
import type { CliContext } from "./context.js";

/** Only daemon control owns a database; all data commands use HTTP. */
export const withRunStore = <A, E, R>(
  context: Pick<CliContext, "home" | "leaseMs">,
  use: (store: SqliteRunStore) => Effect.Effect<A, E, R>,
) => Effect.scoped(Effect.flatMap(openRunStore(context.home, { leaseMs: context.leaseMs }), use));
