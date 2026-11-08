import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeRouteResponse,
  type Route,
  type RouteInput,
  type RouteResult,
  routeRequest,
} from "@loopy/contract";
import { tryPidLock } from "@loopy/runtime/os";
import { type Config, config, state } from "./config";
import { CONCURRENCY } from "./plan";

export class PlaygroundClient {
  private constructor(readonly settings: Config) {}

  static async open() {
    return new PlaygroundClient(await config());
  }

  /** Takes a path from the API origin, such as one from routeUrl. */
  async request(path: string, signal?: AbortSignal, init: RequestInit = {}) {
    if (!path.startsWith("/api/")) {
      throw new Error("Use an API path beginning with /api/.");
    }

    await mkdir(resolve(state, "api-slots"), { recursive: true });
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      for (let index = 0; index < CONCURRENCY; index += 1) {
        const slot = tryPidLock(resolve(state, "api-slots", `${index}.lock`));

        if (slot.kind !== "acquired") {
          continue;
        }

        try {
          const response = await fetch(`${this.settings.api}${path}`, {
            ...init,
            headers: {
              Authorization: `Bearer ${this.settings.token}`,
              "Content-Type": "application/json",
              ...init.headers,
            },
            signal: signal ?? AbortSignal.timeout(30_000),
          });

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

      signal?.throwIfAborted();
      await Bun.sleep(40);
    }

    throw new Error("Global API slots stayed occupied. Inspect api-slots owners before recovery.");
  }

  async call<R extends Route>(route: R, input: RouteInput<R>): Promise<RouteResult<R>> {
    const { method, url, headers, body } = routeRequest(route, input);
    const response = await this.request(url, undefined, { method, headers, body });
    const outcome = decodeRouteResponse(route, response.status, await response.text());

    if (outcome.kind !== "ok") {
      throw new Error(`Playground API ${method} ${route.path} returned HTTP ${response.status}.`);
    }

    return outcome.value;
  }
}
