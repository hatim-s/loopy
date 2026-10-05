import worker from "../src/index.js";
import type { CloudEnv } from "../src/types.js";

export { RunCoordinator } from "../src/coordinator.js";
export default {
  async fetch(request: Request, env: CloudEnv) {
    // Test transport invokes the real scheduled handler. Production exports no trigger route.
    if (new URL(request.url).pathname === "/__fixture/cron") {
      await worker.scheduled({}, env);
      return new Response("swept");
    }
    return worker.fetch(request, env);
  },
};
