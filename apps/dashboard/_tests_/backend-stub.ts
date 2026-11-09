import type { RouteName } from "@loopy/contract";
import type { ApiInput, ApiResult, LoopyBackend } from "../src/backend/backend";

type Handlers = {
  [K in RouteName]: (input: ApiInput<K>, signal?: AbortSignal) => Promise<ApiResult<K>>;
};

/** A backend that answers only the routes a test names and fails loudly on any other. */
export function stubBackend(
  handlers: Partial<Handlers>,
  events: LoopyBackend["events"] = () => Promise.reject(new Error("No event stream stubbed.")),
): LoopyBackend {
  return {
    call(name, input, signal) {
      const handler: Partial<Handlers>[typeof name] = handlers[name];

      if (handler === undefined) {
        return Promise.reject(new Error(`No stub for route ${name}.`));
      }

      return handler(input, signal);
    },
    events,
  };
}
