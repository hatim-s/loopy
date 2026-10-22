import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { compile } from "../../packages/loopy/src/compiler/index.js";
import {
  errorBodySchema,
  type Json,
  putLoopyBodySchema,
  type RunSnapshotView,
  routes,
} from "../../packages/loopy/src/contract/index.js";

const root = resolve(import.meta.dir, "../..");

const evidencePath = resolve(root, ".notes/cloud/evidence/journey.json");

const credentialsSchema = z.object({
  principals: z.array(z.object({ workspace: z.string(), token: z.string().min(1) })),
  sandboxToken: z.string().min(1),
});

type Evidence = Record<string, string | number | boolean | string[]>;

type Result = { name: string; status: "passed" | "failed"; durationMs: number; evidence: Evidence };

export class JourneyFailure extends Error {
  constructor(readonly evidence: Evidence) {
    super("Journey assertion failed. See safe evidence.");
  }
}

export function assert<T>(
  condition: T,
  failure: string,
  evidence: Evidence = {},
): asserts condition {
  if (!condition) {
    throw new JourneyFailure({ failure, ...evidence });
  }
}

export function equal<A, B>(actual: A, expected: B, failure: string): void {
  assert(isDeepStrictEqual(actual, expected), failure);
}

export class Journey {
  readonly results: Result[] = [];
  readonly runs: string[] = [];
  readonly startedAt = new Date().toISOString();
  private constructor(private readonly credentials: z.infer<typeof credentialsSchema>) {}

  static async open() {
    const credentials = credentialsSchema.safeParse(
      await Bun.file(resolve(root, ".loopy/cloud/local.json")).json(),
    );

    assert(credentials.success, "invalid_local_fixture_credentials");

    for (const workspace of ["fixtures", "other"]) {
      assert(
        credentials.data.principals.some((value) => value.workspace === workspace),
        "missing_fixture_principal",
      );
    }

    return new Journey(credentials.data);
  }

  async check(name: string, run: () => Promise<Evidence | undefined>): Promise<void> {
    const start = Date.now();

    try {
      const evidence = await run();
      this.results.push({
        name,
        status: "passed",
        durationMs: Date.now() - start,
        evidence: evidence ?? {},
      });
    } catch (cause) {
      const evidence =
        cause instanceof JourneyFailure ? cause.evidence : { failure: "unexpected_test_error" };

      this.results.push({ name, status: "failed", durationMs: Date.now() - start, evidence });
    }

    await this.save();
    process.stdout.write(`${JSON.stringify(this.results.at(-1))}\n`);
  }

  async save(): Promise<void> {
    await mkdir(resolve(root, ".notes/cloud/evidence"), { recursive: true });
    await Bun.write(
      evidencePath,
      `${JSON.stringify(
        {
          status: this.results.some((result) => result.status === "failed") ? "failed" : "passed",
          scope: "local-stack-journey-only",
          command: "bun --no-env-file scripts/cloud/journey.ts",
          api: "http://127.0.0.1:14870",
          startedAt: this.startedAt,
          updatedAt: new Date().toISOString(),
          runIds: this.runs,
          results: this.results,
        },
        null,
        2,
      )}\n`,
    );
  }

  async request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      principal?: "fixtures" | "other" | "none" | "invalid";
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const principal = options.principal ?? "fixtures";
    const headers = new Headers(options.headers);

    if (principal !== "none") {
      const token =
        principal === "invalid"
          ? "invalid-fixture-token"
          : this.credentials.principals.find((value) => value.workspace === principal)?.token;

      headers.set("Authorization", `Bearer ${token}`);
    }

    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    try {
      return await fetch(`http://127.0.0.1:14870/api${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal ?? AbortSignal.timeout(15_000),
      });
    } catch {
      throw new JourneyFailure({ failure: "local_api_transport_failed", path });
    }
  }

  async json<T>(
    schema: z.ZodType<T>,
    path: string,
    options: Parameters<Journey["request"]>[1] = {},
  ): Promise<T> {
    const response = await this.request(path, options);
    assert(response.ok, "unexpected_http_status", { path, httpStatus: response.status });

    return this.readJson(response, schema, path);
  }

  private async readJson<T>(response: Response, schema: z.ZodType<T>, path: string): Promise<T> {
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      throw new JourneyFailure({
        failure: "non_json_response_discarded",
        httpStatus: response.status,
      });
    }

    const text = await response.text();
    assert(Buffer.byteLength(text) <= 8 * 1024 * 1024, "response_exceeds_8_mib");

    try {
      const parsed = schema.safeParse(JSON.parse(text));
      assert(parsed.success, "response_schema_failed", {
        path,
        issues: parsed.error?.issues.map((issue) => `${issue.code}:${issue.path.join(".")}`) ?? [],
      });

      return parsed.data;
    } catch {
      throw new JourneyFailure({ failure: "invalid_json_response", httpStatus: response.status });
    }
  }

  async denied(
    path: string,
    status: number,
    code: string,
    options: Parameters<Journey["request"]>[1] = {},
  ) {
    const response = await this.request(path, options);
    const actualStatus = response.status;
    const parsed = await this.readJson(response, errorBodySchema, path);
    assert(actualStatus === status && parsed.error.code === code, "expected_denial_failed", {
      path,
      expectedStatus: status,
      actualStatus,
      expectedCode: code,
      actualCode: parsed.error.code,
    });
  }

  async compiled(name: string) {
    const path = resolve(root, "packages/loopy/_tests_/fixtures/cloud", name);
    const result = await compile(path);
    assert(result.ok, "fixture_compile_failed", {
      fixture: name,
      diagnostics: result.ok
        ? []
        : result.diagnostics.map((value) => `${value.code}:${value.line}:${value.column}`),
    });

    return putLoopyBodySchema.parse({
      graph: result.graph,
      revision: result.revision,
      sourceArtifact: result.sourceArtifact,
      bundles: result.bundles.map((bundle) => ({
        ...bundle,
        bytes: Buffer.from(bundle.bytes).toString("base64"),
      })),
      source: { path, workspace: "fixtures" },
      replace: true,
    });
  }

  async upload(body: z.infer<typeof putLoopyBodySchema>) {
    await this.json(routes.putLoopy.response, `/loopies/${body.graph.name}`, {
      method: "PUT",
      body,
    });
  }

  async start(slug: string, input: Json) {
    const run = await this.json(routes.startRun.response, `/loopies/${slug}/runs`, {
      method: "POST",
      body: { input, workspace: "fixtures" },
    });

    this.runs.push(run.id);

    return run;
  }

  async wait(id: string, waiting = false): Promise<RunSnapshotView> {
    const deadline = Date.now() + 90_000;
    let last: RunSnapshotView | undefined;

    while (Date.now() < deadline) {
      last = await this.json(routes.run.response, `/runs/${id}`);

      if (
        ["succeeded", "failed", "cancelled"].includes(last.run.status) ||
        (waiting && last.run.waitingOn)
      ) {
        return last;
      }

      await Bun.sleep(300);
    }

    throw new JourneyFailure({
      failure: "run_wait_timed_out",
      runId: id,
      runStatus: last?.run.status ?? "unknown",
      nodeStatuses:
        last?.nodeRuns.map((node) => `${node.key.nodeId}:${node.status}:${node.attempt}`) ?? [],
    });
  }
}
