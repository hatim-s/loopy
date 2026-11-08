import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compile } from "@loopy/compiler";
import {
  decodeBoundary,
  decodeRouteResponse,
  isTerminalRun,
  type Json,
  type PutLoopyBody,
  type Route,
  type RouteInput,
  type RouteResult,
  type RunSnapshotView,
  routeRequest,
  routes,
  type SandboxAttemptRequest,
} from "@loopy/contract";
import { Effect, type Schema } from "effect";
import { root } from "../stack/constants";
import { assert, type Evidence, failureEvidence, JourneyFailure } from "./assert";
import { until } from "./poll";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function compileFixture(name: string) {
  return Effect.gen(function* () {
    const path = resolve(root, "packages/loopy/_tests_/fixtures/cloud", name);
    const result = yield* compile(path);
    assert(result.ok, "fixture_compile_failed", {
      fixture: name,
      diagnostics: result.ok
        ? []
        : result.diagnostics.map((value) => `${value.code}:${value.line}:${value.column}`),
    });

    const body: PutLoopyBody = {
      graph: result.graph,
      revision: result.revision,
      sourceArtifact: result.sourceArtifact,
      bundles: result.bundles,
      source: { path, workspace: "fixtures" },
      replace: true,
    };

    return body;
  });
}

async function readText(response: Response): Promise<string> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    throw new JourneyFailure({
      failure: "non_json_response_discarded",
      httpStatus: response.status,
    });
  }

  const text = await response.text();
  assert(Buffer.byteLength(text) <= MAX_RESPONSE_BYTES, "response_exceeds_8_mib");

  return text;
}

export async function readJson<T>(
  response: Response,
  schema: Schema.Codec<T, unknown, never, never>,
): Promise<T> {
  const text = await readText(response);

  try {
    return decodeBoundary(schema)(JSON.parse(text));
  } catch {
    throw new JourneyFailure({ failure: "invalid_json_response", httpStatus: response.status });
  }
}

export type CallOptions = {
  token?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/** A raw request for endpoints outside the daemon route table, such as the sandbox provider. */
export type RequestOptions = CallOptions & {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: Json | SandboxAttemptRequest;
};

export class ApiClient {
  constructor(private readonly options: { origin: string; token: string; timeoutMs: number }) {}

  private async fetch(path: string, init: RequestInit, options: CallOptions) {
    const headers = new Headers(init.headers);
    const token = options.token === undefined ? this.options.token : options.token;

    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.set(name, value);
    }

    if (token !== null) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    try {
      return await fetch(`${this.options.origin}${path}`, {
        ...init,
        headers,
        signal: options.signal ?? AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new JourneyFailure({ failure: "local_api_transport_failed", path });
    }
  }

  request(path: string, options: RequestOptions = {}): Promise<Response> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);

    return this.fetch(
      path,
      {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body,
      },
      options,
    );
  }

  send<R extends Route>(route: R, input: RouteInput<R>, options: CallOptions = {}) {
    const { method, url, headers, body } = routeRequest(route, input);

    return this.fetch(url, { method, headers, body }, options);
  }

  async call<R extends Route>(
    route: R,
    input: RouteInput<R>,
    options: CallOptions = {},
  ): Promise<RouteResult<R>> {
    const response = await this.send(route, input, options);

    if (!response.ok) {
      await response.body?.cancel();
      throw new JourneyFailure({
        failure: "unexpected_http_status",
        path: route.path,
        httpStatus: response.status,
      });
    }

    const outcome = decodeRouteResponse(route, response.status, await readText(response));

    if (outcome.kind !== "ok") {
      throw new JourneyFailure({ failure: "invalid_json_response", httpStatus: response.status });
    }

    return outcome.value;
  }

  async json<T>(
    schema: Schema.Codec<T, unknown, never, never>,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.request(path, options);

    if (!response.ok) {
      await response.body?.cancel();
      throw new JourneyFailure({
        failure: "unexpected_http_status",
        path: path.split("?")[0] ?? path,
        httpStatus: response.status,
      });
    }

    return readJson(response, schema);
  }

  waitForRun(
    id: string,
    options: { timeoutMs: number; intervalMs: number; untilWaiting?: boolean },
  ): Promise<RunSnapshotView> {
    return until(
      () => this.call(routes.run, { params: { id } }),
      (snapshot) =>
        isTerminalRun(snapshot.run.status) ||
        (options.untilWaiting === true && snapshot.run.waitingOn !== null),
      {
        timeoutMs: options.timeoutMs,
        intervalMs: options.intervalMs,
        timeout: (last) =>
          new JourneyFailure({
            failure: "run_wait_timed_out",
            runId: id,
            runStatus: last?.run.status ?? "unknown",
            nodeStatuses:
              last?.nodeRuns.map((node) => `${node.key.nodeId}:${node.status}:${node.attempt}`) ??
              [],
          }),
      },
    );
  }
}

type CheckResult = {
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  evidence: Evidence;
};

// Evidence is rewritten after every check so an interrupted journey still leaves its partial record.
export class EvidenceLog {
  readonly results: CheckResult[] = [];
  readonly runs: string[] = [];
  readonly startedAt = new Date().toISOString();

  constructor(
    private readonly path: string,
    private readonly fields: Evidence,
  ) {}

  get passed() {
    return this.results.every((result) => result.status === "passed");
  }

  async check(name: string, action: () => Promise<Evidence | void>) {
    const start = Date.now();
    let result: CheckResult;

    try {
      const evidence = (await action()) ?? {};
      result = { name, status: "passed", durationMs: Date.now() - start, evidence };
    } catch (cause) {
      result = {
        name,
        status: "failed",
        durationMs: Date.now() - start,
        evidence: failureEvidence(cause),
      };
    }

    this.results.push(result);
    await this.save();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }

  async save(extra: Evidence = {}) {
    await mkdir(dirname(this.path), { recursive: true });
    await Bun.write(
      this.path,
      `${JSON.stringify(
        {
          status: this.passed ? "passed" : "failed",
          ...this.fields,
          startedAt: this.startedAt,
          updatedAt: new Date().toISOString(),
          runIds: this.runs,
          results: this.results,
          ...extra,
        },
        null,
        2,
      )}\n`,
    );
  }
}
