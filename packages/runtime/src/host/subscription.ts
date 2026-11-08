import type { RuntimeEvent, Store } from "@loopy/core";
import { Effect } from "effect";

export const subscribeStore = (
  store: Pick<Store, "subscribe">,
  listener: (events: RuntimeEvent[]) => void,
) =>
  Effect.acquireRelease(
    Effect.sync(() => store.subscribe(listener)),
    (unsubscribe) => Effect.sync(unsubscribe),
  ).pipe(Effect.asVoid);
