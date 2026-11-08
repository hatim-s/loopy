import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Json, PutLoopyBody } from "@loopy/contract";
import { decodeBoundary } from "@loopy/contract";
import { errnoCode } from "@loopy/core";
import type { Schema } from "effect";
import { type Config, config, state } from "./config";
import { CONCURRENCY } from "./plan";

export class PlaygroundClient {
  private constructor(readonly settings: Config) {}

  static async open() {
    return new PlaygroundClient(await config());
  }

  async request(path: string, signal?: AbortSignal, init: RequestInit = {}) {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error("Use a relative API path beginning with one slash.");
    }

    await mkdir(resolve(state, "api-slots"), { recursive: true });
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      for (let index = 0; index < CONCURRENCY; index += 1) {
        const slot = resolve(state, "api-slots", `${index}`);

        try {
          await mkdir(slot);
        } catch (cause) {
          if (errnoCode(cause) === "EEXIST") {
            continue;
          }

          throw cause;
        }

        try {
          await writeFile(
            resolve(slot, "owner.json"),
            JSON.stringify({ pid: process.pid, at: Date.now() }),
          );

          const response = await fetch(`${this.settings.api}/api${path}`, {
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
          await rm(slot, { recursive: true });
        }
      }

      signal?.throwIfAborted();
      await Bun.sleep(40);
    }

    throw new Error("Global API slots stayed occupied. Inspect api-slots owners before recovery.");
  }

  async json<T>(
    schema: Schema.Codec<T, unknown, never, never>,
    path: string,
    options: { method?: "POST" | "PUT"; body?: Json | PutLoopyBody } = {},
  ) {
    const method = options.body === undefined ? "GET" : (options.method ?? "POST");

    const response = await this.request(path, undefined, {
      method,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Playground API ${method} ${path.split("?")[0]} returned HTTP ${response.status}.`,
      );
    }

    return decodeBoundary(schema)(await response.json());
  }
}
