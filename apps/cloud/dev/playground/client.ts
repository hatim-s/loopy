import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tryPidLock } from "@loopy/runtime/os";
import { ApiClient } from "../shared/fixture-client";
import { type Config, config, state } from "./config";
import { CONCURRENCY } from "./plan";

// Every playground process shares CONCURRENCY API slots through pid locks, so parallel tools
// cannot push the Worker past the load the batch was sized for.
async function slotted(url: string, init: RequestInit) {
  await mkdir(resolve(state, "api-slots"), { recursive: true });
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    for (let index = 0; index < CONCURRENCY; index += 1) {
      const slot = tryPidLock(resolve(state, "api-slots", `${index}.lock`));

      if (slot.kind !== "acquired") {
        continue;
      }

      try {
        const response = await fetch(url, init);
        // The slot covers the body transfer, so it is read before release.
        const bytes = await response.arrayBuffer();

        return new Response(bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } finally {
        slot.release();
      }
    }

    init.signal?.throwIfAborted();
    await Bun.sleep(40);
  }

  throw new Error("Global API slots stayed occupied. Inspect api-slots owners before recovery.");
}

export class PlaygroundClient extends ApiClient {
  private constructor(readonly settings: Config) {
    super({ origin: settings.api, token: settings.token, timeoutMs: 30_000, transport: slotted });
  }

  static async open() {
    return new PlaygroundClient(await config());
  }

  /** The same principal without the shared slots, for measuring what the slots cost. */
  direct() {
    return new ApiClient({
      origin: this.settings.api,
      token: this.settings.token,
      timeoutMs: 30_000,
    });
  }
}
