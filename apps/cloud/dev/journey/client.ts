import { resolve } from "node:path";
import { errorBodySchema, type Json, type PutLoopyBody, routes } from "@loopy/contract";
import type { Schema } from "effect";
import { assert } from "../shared/assert";
import { ApiClient, EvidenceLog, type RequestOptions, readJson } from "../shared/fixture-client";
import { root } from "../stack/constants";
import { principalToken, readLocalCredentials } from "../stack/credentials";

const api = "http://127.0.0.1:14870";

type Principal = "fixtures" | "other" | "none" | "invalid";

export type JourneyRequest = Omit<RequestOptions, "token"> & { principal?: Principal };

export class Journey {
  readonly evidence = new EvidenceLog(resolve(root, ".notes/cloud/evidence/journey.json"), {
    scope: "local-stack-journey-only",
    command: "bun --no-env-file apps/cloud/dev/journey/index.ts",
    api,
  });

  private readonly client: ApiClient;

  private constructor(private readonly tokens: { fixtures: string; other: string }) {
    this.client = new ApiClient({ base: `${api}/api`, token: tokens.fixtures, timeoutMs: 15_000 });
  }

  static async open() {
    const credentials = await readLocalCredentials();

    return new Journey({
      fixtures: principalToken(credentials, "fixtures"),
      other: principalToken(credentials, "other"),
    });
  }

  private token(principal: Principal = "fixtures") {
    switch (principal) {
      case "none":
        return null;
      case "invalid":
        return "invalid-fixture-token";
      default:
        return this.tokens[principal];
    }
  }

  request(path: string, { principal, ...options }: JourneyRequest = {}) {
    return this.client.request(path, { ...options, token: this.token(principal) });
  }

  json<T>(
    schema: Schema.Codec<T, unknown, never, never>,
    path: string,
    { principal, ...options }: JourneyRequest = {},
  ) {
    return this.client.json(schema, path, { ...options, token: this.token(principal) });
  }

  async denied(path: string, status: number, code: string, options: JourneyRequest = {}) {
    const response = await this.request(path, options);
    const actualStatus = response.status;
    const parsed = await readJson(response, errorBodySchema);
    assert(actualStatus === status && parsed.error.code === code, "expected_denial_failed", {
      path,
      expectedStatus: status,
      actualStatus,
      expectedCode: code,
      actualCode: parsed.error.code,
    });
  }

  async upload(body: PutLoopyBody) {
    await this.json(routes.putLoopy.response, `/loopies/${body.graph.name}`, {
      method: "PUT",
      body,
    });
  }

  async start(slug: string, input: Json) {
    const run = await this.json(routes.startRun.response, `/loopies/${slug}/runs`, {
      body: { input, workspace: "fixtures" },
    });

    this.evidence.runs.push(run.id);

    return run;
  }

  wait(id: string) {
    return this.client.waitForRun(id, { timeoutMs: 90_000, intervalMs: 300 });
  }

  waitForHook(id: string) {
    return this.client.waitForRun(id, { timeoutMs: 90_000, intervalMs: 300, untilWaiting: true });
  }
}
