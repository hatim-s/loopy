import { resolve } from "node:path";
import {
  errorBodySchema,
  type Json,
  type PutLoopyBody,
  type Route,
  type RouteInput,
  routes,
} from "@loopy/contract";
import { assert } from "../shared/assert";
import {
  ApiClient,
  type CallOptions,
  EvidenceLog,
  type RequestOptions,
  readJson,
} from "../shared/fixture-client";
import { root } from "../stack/constants";
import { principalToken, readLocalCredentials } from "../stack/credentials";
import { LOCAL_STACK } from "../stack/ports";

const api = LOCAL_STACK.origin("api");

type Principal = "fixtures" | "other" | "none" | "invalid";

type As = { principal?: Principal };

export type JourneyCall = Omit<CallOptions, "token"> & As;

export type JourneyRequest = Omit<RequestOptions, "token"> & As;

export class Journey {
  readonly evidence = new EvidenceLog(resolve(root, ".notes/cloud/evidence/journey.json"), {
    scope: "local-stack-journey-only",
    command: "bun --no-env-file apps/cloud/dev/journey/index.ts",
    api,
  });

  private readonly client: ApiClient;

  private constructor(private readonly tokens: { fixtures: string; other: string }) {
    this.client = new ApiClient({ origin: api, token: tokens.fixtures, timeoutMs: 15_000 });
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

  send<R extends Route>(
    route: R,
    input: RouteInput<R>,
    { principal, ...options }: JourneyCall = {},
  ) {
    return this.client.send(route, input, { ...options, token: this.token(principal) });
  }

  call<R extends Route>(
    route: R,
    input: RouteInput<R>,
    { principal, ...options }: JourneyCall = {},
  ) {
    return this.client.call(route, input, { ...options, token: this.token(principal) });
  }

  async denied(sent: Promise<Response>, status: number, code: string) {
    const response = await sent;
    const actualStatus = response.status;
    const parsed = await readJson(response, errorBodySchema);
    assert(actualStatus === status && parsed.error.code === code, "expected_denial_failed", {
      path: new URL(response.url).pathname,
      expectedStatus: status,
      actualStatus,
      expectedCode: code,
      actualCode: parsed.error.code,
    });
  }

  async upload(body: PutLoopyBody) {
    await this.call(routes.putLoopy, { params: { slug: body.graph.name }, body });
  }

  async start(slug: string, input: Json) {
    const run = await this.call(routes.startRun, {
      params: { slug },
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
