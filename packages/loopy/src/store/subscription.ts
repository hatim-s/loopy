import { Effect } from "effect";
import type { RuntimeEvent, Store } from "../core";

export const subscribeStore = (
  store: Pick<Store, "subscribe">,
  listener: (events: RuntimeEvent[]) => void,
) =>
  Effect.acquireRelease(
    Effect.sync(() => store.subscribe(listener)),
    (unsubscribe) => Effect.sync(unsubscribe),
  ).pipe(Effect.asVoid);
