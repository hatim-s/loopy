import { expect, expectTypeOf, test } from "bun:test";
import { graphSchema, graphView, refIdSchema } from "../src/contract/index.js";
import {
  type DiagnosticCode,
  graphTypeResolver,
  type Json,
  renderArgv,
  validateGraph,
} from "../src/core/index.js";
import type { NodeResult } from "../src/sdk/graph/ref.js";
import {
  and,
  archive,
  branch,
  code,
  defineCommand,
  eq,
  exists,
  fail,
  finally_,
  format,
  fs,
  GraphBuildError,
  git,
  gt,
  gte,
  in_,
  isNull,
  log,
  loopy,
  lt,
  lte,
  map,
  ne,
  net,
  not,
  now,
  or,
  parallel,
  type Ref,
  random,
  rescue,
  sh,
  size,
  sleep,
  subgraph,
  switch_,
  text,
  uuid,
  wait,
} from "../src/sdk/index.js";
import assetSync from "./fixtures/graph-examples/asset-sync.js";
import hello from "./fixtures/graph-examples/hello.js";
import review from "./fixtures/graph-examples/review.js";
import wwwSync from "./fixtures/graph-examples/www-sync.js";
import { approveDemoGraph } from "./fixtures/graphs.js";

function compile(run: () => NodeResult) {
  const result = loopy("test", { input: {}, run });
  expect(result.diagnostics).toEqual([]);
  expect(validateGraph(result.graph)).toEqual([]);
  expect(graphSchema.parse(result.graph)).toEqual(result.graph);

  return result.graph;
}

function rejects(code: DiagnosticCode, run: () => void) {
  try {
    run();
    throw new Error("Expected construction to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(GraphBuildError);

    if (error instanceof GraphBuildError) {
      expect(error.diagnostic.code).toBe(code);
      expect(error.diagnostic.source).toBeNull();
    }
  }
}

test("approve-demo reproduces the canonical graph exactly", () => {
  const result = loopy("approve-demo", {
    input: { "subject?": "string" },
    run: ({ input }) => {
      const draft = code("draft", {
        in: { subject: input.get("subject") },
        out: { kind: "record", fields: { words: "number" } },
        module: "./draft.ts",
      });

      log("Draft ready");

      const approval = wait("approve", {
        timeout: "1h",
        payload: { kind: "record", fields: { approved: "boolean" } },
      });

      const applied = branch(eq(approval.get("approved"), true), {
        yes: () =>
          sh(["bun", "apply.ts", format("{n} words", { n: draft.get("words") })], {
            label: "apply",
          }),
        no: () => fail("Rejected"),
      });

      return { draft, applied };
    },
  });

  expect(result.diagnostics).toEqual([]);
  expect(validateGraph(result.graph)).toEqual([]);
  expect(graphSchema.parse(result.graph)).toEqual(approveDemoGraph);
});

const simple = [
  [
    "code",
    () =>
      code("work", {
        in: { nested: { count: 1 } },
        out: { kind: "record", fields: { words: "number" } },
        module: "./work.ts",
      }),
    {
      in: { nested: { count: 1 } },
      module: { path: "./work.ts", bundleHash: null },
      out: { kind: "record", fields: { words: "number" } },
    },
  ],
  [
    "command",
    () => sh.exec(["echo", "hello"], { label: "echo" }),
    { key: "sh.exec", argv: ["echo", "hello"], flags: {}, parse: null },
  ],
  [
    "wait",
    () =>
      wait("approval", {
        timeout: "1h",
        payload: { kind: "record", fields: { approved: "boolean" } },
      }),
    { timeout: "1h", payload: { kind: "record", fields: { approved: "boolean" } } },
  ],
  ["sleep", () => sleep("1m"), { duration: "1m" }],
  ["format", () => format("{n}", { n: 3 }), { template: "{n}", values: { n: 3 } }],
  ["log", () => log("hello", { ok: true }), { message: "hello", data: { ok: true } }],
  ["now", now, {}],
  ["uuid", uuid, {}],
  ["random", random, {}],
] as const;

for (const [kind, run, expected] of simple) {
  test(`${kind} records a node and connects its final join`, () => {
    const graph = compile(run);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]).toMatchObject({ kind, ...expected });
    expect(graph.nodes[1]).toMatchObject({
      kind: "join",
      result: { kind: "value", value: { ref: graph.entry, path: [] } },
    });
    expect<unknown>(graph.edges).toEqual([{ from: graph.entry, to: "1:join", kind: "next" }]);
  });
}

test("fail is terminal and never receives a scope join", () => {
  const graph = compile(() => fail("stop"));
  expect(graph.nodes[0]).toMatchObject({ kind: "fail", message: "stop" });
  expect<unknown>(graph.edges).toEqual([]);
});

test("branch carries each successful arm result in its own join", () => {
  const graph = compile(() => branch(lt(1, 2), { yes: () => "yes", no: () => 3 }));

  expect(graph.nodes.map((node) => node.kind)).toEqual(["branch", "join", "join", "join", "join"]);
  expect(graph.nodes[1]).toMatchObject({
    scope: "0:branch",
    result: { kind: "value", value: "yes" },
  });
  expect(graph.nodes[2]).toMatchObject({ scope: "0:branch", result: { kind: "value", value: 3 } });
  expect<unknown>(graph.edges).toEqual([
    { from: "1:join", to: "3:join", kind: "join" },
    { from: "2:join", to: "3:join", kind: "join" },
    { from: "3:join", to: "4:join", kind: "next" },
  ]);
});

test("map binds item and index, collects errors, and joins back to its owner", () => {
  const graph = compile(() =>
    map(
      code("files", {
        in: {},
        out: { kind: "record", fields: { paths: "string[]" } },
        module: "./files.ts",
      }).get("paths"),
      (item, index) => format("{index}:{item}", { index, item }),
      {
        onError: "collect",
      },
    ),
  );

  expect(graph.nodes[1]).toMatchObject({
    kind: "map",
    concurrency: 4,
    onError: "collect",
    item: "1:map:item",
    index: "1:map:index",
    body: "2:format",
  });
  expect(graph.nodes[2]).toMatchObject({
    values: { index: { ref: "1:map:index", path: [] }, item: { ref: "1:map:item", path: [] } },
  });
  expect<unknown>(graph.edges).toContainEqual({ from: "3:join", to: "1:map", kind: "join" });
  expect<unknown>(graph.edges).toContainEqual({ from: "1:map", to: "4:join", kind: "next" });
});

test("parallel expands two independent branches", () => {
  const graph = compile(() => parallel({ a: uuid, b: now }));
  expect(graph.nodes[0]).toMatchObject({ kind: "parallel", branches: { a: "1:uuid", b: "3:now" } });
  expect<unknown>(graph.edges).toEqual([
    { from: "1:uuid", to: "2:join", kind: "next" },
    { from: "2:join", to: "5:join", kind: "join" },
    { from: "3:now", to: "4:join", kind: "next" },
    { from: "4:join", to: "5:join", kind: "join" },
    { from: "5:join", to: "6:join", kind: "next" },
  ]);
});

test("finally records body and cleanup paths with the body result", () => {
  const graph = compile(() => finally_(uuid, () => log("cleanup")));
  expect(graph.nodes[0]).toMatchObject({ kind: "finally", body: "1:uuid", cleanup: "3:log" });
  expect<unknown>(graphView(graph).edges).toContainEqual({
    from: "0:finally",
    to: "3:log",
    kind: "cleanup",
  });
  expect(graph.nodes[2]).toMatchObject({
    kind: "join",
    result: { kind: "value", value: { ref: "1:uuid", path: [] } },
  });
});

test("rescue binds its error only in the handler", () => {
  const graph = compile(() =>
    rescue(
      () => fail("failed"),
      (error) => log(error.get("message")),
    ),
  );

  expect(graph.nodes[0]).toMatchObject({
    kind: "rescue",
    body: "1:fail",
    handler: "2:log",
    error: "0:rescue:error",
  });
  expect<unknown>(graphView(graph).edges).toContainEqual({
    from: "0:rescue",
    to: "2:log",
    kind: "rescue",
  });
  expect(graph.nodes[2]).toMatchObject({
    message: { ref: "0:rescue:error", path: ["message"] },
  });
});

test("switch records literal cases and default", () => {
  const graph = compile(() => switch_(uuid(), { first: () => 1, default: () => 2 }));
  expect(graph.nodes[1]).toMatchObject({
    kind: "switch",
    cases: { first: "2:join" },
    default: "3:join",
  });
  expect<unknown>(graphView(graph).edges).toContainEqual({
    from: "1:switch",
    to: "3:join",
    kind: "case",
    label: "default",
  });
});

test("subgraphs expand inline with nested prefixes and shared allocation", () => {
  const inner = subgraph("inner", uuid);
  const outer = subgraph("outer", () => ({ id: inner(), time: now() }));
  const graph = compile(outer);
  expect(graph.nodes.map((node) => String(node.id))).toEqual([
    "0:outer/inner/uuid",
    "1:outer/now",
    "2:join",
  ]);
});

test("all shell namespaces use descriptors and record parsers without executing them", () => {
  const graph = compile(() => ({
    git: git.status({}, { label: "status" }),
    fs: fs.ls({}, { label: "ls" }),
    text: text.wc({}, { label: "wc" }),
    net: net.curl({ args: ["https://example.com"] }, { label: "curl" }),
    archive: archive.tar({ args: ["file"], flags: { list: true } }, { label: "tar" }),
    custom: defineCommand(
      {
        key: "custom",
        program: "echo",
        parse: "./not-executed.ts",
      },
      { kind: "value", type: "json" },
    )({}, { label: "custom" }),
  }));

  const commands = graph.nodes.filter((node) => node.kind === "command");
  expect(commands.map((node) => node.key)).toEqual([
    "git.status",
    "fs.ls",
    "text.wc",
    "net.curl",
    "archive.tar",
    "custom",
  ]);
  expect(
    commands.map((node) => (node.parse === null ? null : { bundleHash: node.parse.bundleHash })),
  ).toEqual([
    { bundleHash: null },
    { bundleHash: null },
    { bundleHash: null },
    { bundleHash: null },
    null,
    { bundleHash: null },
  ]);
  expect(commands[1]?.argv).toEqual(["find", "."]);
});

test("command argv, flags and options preserve symbolic values", () => {
  const graph = compile(() => {
    const value = uuid();

    return git.commit(
      { flags: { message: value } },
      { label: "commit", cwd: value, env: { ID: value }, stdin: value },
    );
  });

  expect(graph.nodes[1]).toMatchObject({
    argv: ["git"],
    flags: { message: { ref: "0:uuid", path: [] } },
    options: {
      cwd: { ref: "0:uuid", path: [] },
      env: { ID: { ref: "0:uuid", path: [] } },
      stdin: { ref: "0:uuid", path: [] },
    },
  });
});

test("refs cannot cross builders, including input refs", () => {
  let foreign: Ref<string> | undefined;
  loopy("first", {
    input: { value: "string" },
    run: ({ input }) => {
      foreign = input.get("value");

      return null;
    },
  });
  rejects("out_of_scope_ref", () => compile(() => log("foreign", foreign)));
});

test("an enclosing earlier ref is visible within nested scopes", () => {
  const graph = compile(() => {
    const id = uuid();

    return parallel({
      a: () => branch(eq(id, "x"), { yes: () => id, no: () => null }),
      b: () => id,
    });
  });

  expect(graph.nodes[0]?.kind).toBe("uuid");
});

test("labels are unique per scope and builders restore activation after errors", () => {
  rejects("duplicate_label", () =>
    compile(() => {
      wait("same", { payload: { kind: "record", fields: {} } });

      return wait("same", { payload: { kind: "record", fields: {} } });
    }),
  );
  rejects("inactive_builder", uuid);
  rejects("inactive_builder", () => compile(() => compile(uuid).name));
  expect(compile(uuid).nodes[0]?.kind).toBe("uuid");
  expect(
    compile(() =>
      parallel({
        a: () => wait("same", { payload: { kind: "record", fields: {} } }),
        b: () => wait("same", { payload: { kind: "record", fields: {} } }),
      }),
    ).nodes,
  ).toHaveLength(7);
});

test("declared predicate types reject mismatched operands at the call site", () => {
  rejects("operand_type", () =>
    compile(() => {
      const n = code("n", {
        in: {},
        out: { kind: "record", fields: { n: "number" } },
        module: "./n.ts",
      });

      // @ts-expect-error Runtime validation also protects untyped callers.
      return branch(eq(n.get("n"), "wrong"), { yes: () => 1, no: () => 0 });

      return null;
    }),
  );
  rejects("operand_type", () =>
    compile(() => {
      // @ts-expect-error Runtime validation also protects untyped callers.
      return branch(in_(uuid(), [1]), { yes: () => 1, no: () => 0 });

      return null;
    }),
  );
});

test("predicates serialize the closed vocabulary and size only in comparisons", () => {
  const graph = compile(() => {
    const value = uuid();

    return branch(
      and(
        eq(value, "a"),
        ne(value, "b"),
        lt(1, 2),
        lte(1, 2),
        gt(size(value), 0),
        gte(2, 1),
        exists(value),
        isNull(value),
        in_(value, ["a"]),
        or(not(eq(value, "b"))),
      ),
      { yes: () => 1, no: () => 0 },
    );
  });

  expect(graph.nodes[1]).toMatchObject({
    predicate: {
      op: "and",
      predicates: expect.arrayContaining([
        { op: "gt", left: { ref: "0:uuid", path: [], size: true }, right: 0 },
      ]),
    },
  });
  rejects("invalid_size", () =>
    compile(() => {
      // @ts-expect-error size markers cannot be values.
      return log("bad", size(uuid()));
    }),
  );
});

test("schemas determine output refs, unknown keys fail, and branch results form a union", () => {
  compile(() => {
    const output = code("typed", {
      in: {},
      out: { kind: "record", fields: { words: "number", "title?": "string" } },
      module: "./typed.ts",
    });

    expectTypeOf(output.get("words")).toEqualTypeOf<Ref<number>>();
    expectTypeOf(output.get("title")).toEqualTypeOf<Ref<string | undefined>>();

    const result = branch(lt(1, 2), { yes: () => output.get("words"), no: () => "none" });

    expectTypeOf(result).toEqualTypeOf<Ref<number | "none">>();
    // @ts-expect-error declared output has no unknown key.
    output.get("unknown");

    return result;
  });
});

for (const [name, result, expectedName] of [
  ["hello", hello, "hello"],
  ["review", review, "review"],
  ["asset-sync", assetSync, "uacode-asset-sync"],
  ["www-sync", wwwSync, "www-uacode-sync"],
] as const) {
  test(`${name} example compiles to a validated graph without executing modules`, () => {
    expect(result.diagnostics).toEqual([]);
    expect(validateGraph(result.graph)).toEqual([]);
    expect(graphSchema.parse(result.graph).nodes.length).toBeGreaterThan(2);
    expect(result.graph.name).toBe(expectedName);
  });
}

test("subgraph invocations reuse labels without sharing their label namespace", () => {
  const task = subgraph("task", () =>
    code("work", { in: {}, out: { kind: "record", fields: {} }, module: "./work.ts" }),
  );

  const graph = compile(() => [task(), task()]);
  expect(graph.nodes.map((node) => String(node.id))).toEqual([
    "0:task/work",
    "1:task/work",
    "2:join",
  ]);
});

test("dynamic flags preserve all descriptor rendering rules for the executor", () => {
  const command = defineCommand({
    key: "flags",
    program: "tool",
    path: ["sub"],
    style: "equals",
    flagsAfterPositionals: true,
    flags: {
      enabled: { cli: "--enabled", kind: "boolean" },
      count: { cli: "-n", kind: "number", style: "attached" },
      tag: { cli: "--tag", kind: "string", repeatable: true },
      named: { cli: "--arg", kind: "string", style: "pairs" },
    },
    operands: { kind: "positional", parts: undefined, separator: true },
  });

  const graph = compile(() => {
    const values = wait("values", {
      payload: { kind: "record", fields: { enabled: "boolean", count: "number", tag: "string" } },
    });

    return command({
      args: [values.get("tag")],
      flags: {
        enabled: values.get("enabled"),
        count: values.get("count"),
        tag: [values.get("tag"), "literal"],
        named: { name: values.get("tag") },
      },
    });
  });

  expect(graph.nodes[1]).toMatchObject({
    kind: "command",
    argv: ["tool", { ref: "0:values", path: ["tag"] }],
    flags: {
      enabled: { ref: "0:values", path: ["enabled"] },
      count: { ref: "0:values", path: ["count"] },
      tag: [{ ref: "0:values", path: ["tag"] }, "literal"],
      named: { name: { ref: "0:values", path: ["tag"] } },
    },
    flagSpec: {
      path: ["sub"],
      style: "equals",
      positionalSeparator: true,
      flagsAfterPositionals: true,
      flags: {
        enabled: { cli: "--enabled", kind: "boolean" },
        count: { cli: "-n", kind: "number", style: "attached" },
        tag: { cli: "--tag", kind: "string", repeatable: true },
        named: { cli: "--arg", kind: "string", style: "pairs" },
      },
    },
  });
  expect(graph.nodes.map((node) => node.kind)).toEqual(["wait", "command", "join"]);
});

test("size rejects declared non-string scalars and unknown fields are errors", () => {
  rejects("invalid_size", () =>
    compile(() => {
      const output = wait("number", { payload: { kind: "record", fields: { count: "number" } } });

      // @ts-expect-error size accepts only string and array refs.
      return branch(gt(size(output.get("count")), 1), { yes: () => 1, no: () => 0 });

      return null;
    }),
  );
});

test("raw shell identities and fs.ls's separate raw descriptor survive", () => {
  const graph = compile(() => ({
    line: sh.run("echo 'hello world'", { label: "line" }),
    ls: fs.ls.raw({}, { label: "raw-ls" }),
  }));

  expect(graph.nodes[0]).toMatchObject({ key: "sh.run", argv: ["echo", "hello world"] });
  expect(graph.nodes[1]).toMatchObject({
    key: "fs.ls",
    argv: ["ls"],
    parse: null,
    flags: {},
    flagSpec: { path: [] },
  });
});

test("stored descriptor data renders false booleans, attached values and ordered flags after resolution", () => {
  const command = defineCommand({
    key: "render",
    program: "tool",
    path: ["sub"],
    style: "equals",
    flagsAfterPositionals: true,
    flags: {
      enabled: { cli: "--enabled", kind: "boolean" },
      count: { cli: "-n", kind: "number", style: "attached" },
      tag: { cli: "--tag", kind: "string", repeatable: true },
    },
    operands: { kind: "positional", parts: undefined, separator: true },
  });

  const graph = compile(() =>
    command({ args: [uuid()], flags: { enabled: false, count: 7, tag: ["a", "b"] } }),
  );

  const node = graph.nodes[1];

  if (node?.kind !== "command" || !node.flagSpec) {
    throw new Error("Expected a descriptor command.");
  }

  expect(
    renderArgv(node.flagSpec, {
      args: ["resolved-id"],
      flags: { enabled: false, count: 7, tag: ["a", "b"] },
    }),
  ).toEqual(["sub", "--", "resolved-id", "-n7", "--tag=a", "--tag=b"]);
});

test("collect maps infer success and failure outcomes while fail maps preserve values", () => {
  const result = loopy("map-types", {
    input: { names: "string[]", counts: "number[]", flags: "boolean[]", records: "json[]" },
    run: ({ input }) => {
      expectTypeOf(input.get("names")).toEqualTypeOf<Ref<string[]>>();
      expectTypeOf(input.get("counts")).toEqualTypeOf<Ref<number[]>>();
      expectTypeOf(input.get("flags")).toEqualTypeOf<Ref<boolean[]>>();
      const collected = map(input.get("names"), (item) => item, { onError: "collect" });
      expectTypeOf(collected).toEqualTypeOf<
        Ref<
          (
            | { ok: true; value: string }
            | {
                ok: false;
                error: { message: string; code: string; data: Json };
              }
          )[]
        >
      >();
      const plain = map(input.get("names"), (item) => item, { onError: "fail" });
      expectTypeOf(plain).toEqualTypeOf<Ref<string[]>>();

      return { collected, plain };
    },
  });

  expect(validateGraph(result.graph)).toEqual([]);
});

test("known command fields resolve through main's validator without synthetic value nodes", () => {
  const graph = compile(() => {
    const status = git.status();
    const response = net.curl({ args: ["https://example.com"] });
    const matches = text.grep({ args: ["needle", "file"] });
    const command = sh(["echo", "hello"]);
    const archived = archive.tar({ args: ["file"], flags: { list: true } });
    const file = fs.cat({ args: ["file"] });

    return branch(
      and(
        gt(status.get("ahead"), 0),
        gt(size(status.get("untracked")), 0),
        eq(response.get("status"), 200),
        gt(size(matches.get("binaryMatches")), 0),
        eq(command.get("exitCode"), 0),
        eq(archived.get("exitCode"), 0),
        gt(size(file.get("stdout")), 0),
      ),
      { yes: () => format("{body}", { body: response.get("body") }), no: () => null },
    );
  });

  expect(graph.nodes[0]).toMatchObject({ id: "0:git.status", label: null });
  expect(graph.nodes[3]).toMatchObject({ id: "3:sh.exec", label: null });
});

test("reserved value keys and opaque JSON comparisons are rejected", () => {
  rejects("reserved_name", () => compile(() => log("bad", { nested: { ref: "reserved" } })));
  rejects("operand_type", () =>
    compile(() => {
      const value = code("opaque", {
        in: {},
        out: { kind: "record", fields: { value: "json" } },
        module: "./opaque.ts",
      });

      // @ts-expect-error Opaque JSON is not a scalar comparison operand.
      return branch(eq(value.get("value"), 1), { yes: () => true, no: () => false });
    }),
  );
});

for (const [kind, control] of [
  ["branch", () => branch(eq(uuid(), "yes"), { yes: uuid, no: uuid })],
  ["switch", () => switch_(uuid(), { first: uuid, default: uuid })],
  ["parallel", () => parallel({ a: uuid, b: now })],
  ["map", () => map(fs.ls(), (item) => item, { onError: "fail" })],
  ["rescue", () => rescue(uuid, (error) => error.get("message"))],
  ["finally", () => finally_(uuid, () => log("cleanup"))],
] as const) {
  test(`${kind} joins its result before the next executable node`, () => {
    const graph = compile(() => {
      const result = control();
      log("after");

      return result;
    });

    const after = graph.nodes.find((node) => node.kind === "log" && node.message === "after");
    const edge = graph.edges.find((edge) => edge.to === after?.id);
    const join = graph.nodes.find((node) => node.id === edge?.from);
    const owner = graph.nodes.find((node) => node.kind === kind);
    expect(edge?.kind).toBe("next");
    expect(join).toMatchObject({
      kind: "join",
      scope: null,
      result: { kind: "value", value: { ref: owner?.id, path: [] } },
    });
  });
}

test("parallel projections and rescue error fields retain their core types", () => {
  compile(() => {
    const result = parallel({ a: uuid, n: random });
    eq(result.get("a"), "id");
    gt(result.get("n"), 0);

    return rescue(
      () => fail("failed"),
      (error) => {
        expectTypeOf(error.get("message")).toEqualTypeOf<Ref<string>>();
        expectTypeOf(error.get("code")).toEqualTypeOf<Ref<string>>();

        return branch(eq(error.get("code"), "failed"), {
          yes: () => format("{message}", { message: error.get("message") }),
          no: () => log("failure data", error.get("data")),
        });
      },
    );
  });
});

for (const [kind, control] of [
  ["branch", () => branch(eq(uuid(), "yes"), { yes: () => fail("yes"), no: () => fail("no") })],
  ["switch", () => switch_(uuid(), { default: () => fail("default") })],
  ["parallel", () => parallel({})],
  ["failing parallel", () => parallel({ a: () => fail("a"), b: () => fail("b") })],
  [
    "rescue",
    () =>
      rescue(
        () => fail("body"),
        () => fail("handler"),
      ),
  ],
  [
    "finally",
    () =>
      finally_(
        () => fail("body"),
        () => fail("cleanup"),
      ),
  ],
] as const) {
  test(`${kind} with no successful arm tails keeps its join without plumbing diagnostics`, () => {
    const result = loopy("test", {
      input: {},
      run: () => {
        control();

        return log("after");
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(validateGraph(result.graph)).toEqual(result.diagnostics);
    expect(graphSchema.parse(result.graph)).toEqual(result.graph);
  });
}

test("a failing rescue body leaves a numeric handler result", () => {
  compile(() => {
    const result = rescue(
      () => fail("oops"),
      () => 3,
    );

    return branch(gt(result, 0), { yes: () => 1, no: () => 0 });
  });
});

test("a branch arm ending in fail after another node does not widen its result", () => {
  compile(() => {
    const result = branch(eq(uuid(), "yes"), {
      yes: () => {
        log("before failure");

        return fail("oops");
      },
      no: () => 3,
    });

    return branch(gt(result, 0), { yes: () => 1, no: () => 0 });
  });
});

test("rescue resolves a non-returning finally body to its numeric handler", () => {
  const graph = compile(() =>
    rescue(
      () =>
        finally_(
          () => fail("oops"),
          () => log("cleanup"),
        ),
      () => 3,
    ),
  );

  expect(graphTypeResolver(graph)({ ref: refIdSchema.parse("0:rescue"), path: [] })).toBe("number");
  expect(
    graph.nodes.filter((node) => node.kind === "join" && node.result.kind === "none"),
  ).toHaveLength(2);
});

test("author references to an all-failing branch remain unresolved", () => {
  const result = loopy("never-ref", {
    input: {},
    run: () => {
      const failed = branch(lt(1, 2), {
        yes: () => fail("yes"),
        no: () => fail("no"),
      });

      return log("author ref", failed);
    },
  });

  expect(result.diagnostics.map(({ code }) => code)).toEqual(["unresolved_ref"]);
  expect(result.diagnostics[0]?.node).toBe(
    result.graph.nodes.find((node) => node.kind === "log")?.id,
  );
});

test("a rescue accepts a map body ending in fail", () => {
  const result = loopy("failing-map", {
    input: { items: "string[]" },
    run: ({ input }) =>
      rescue(
        () => map(input.get("items"), () => fail("oops"), { onError: "fail" }),
        () => 3,
      ),
  });

  expect(result.diagnostics).toEqual([]);
  expect(validateGraph(result.graph)).toEqual([]);
  expect(graphSchema.parse(result.graph)).toEqual(result.graph);
});

for (const label of ["__proto__", "constructor", "prototype"]) {
  const fields = { [label]: "string" } as const;
  const schema = { kind: "record", fields: {} } as const;
  const callbacks = { [label]: () => 1 };

  const cases: [string, () => void][] = [
    ["parallel", () => compile(() => parallel(callbacks))],
    ["switch", () => compile(() => switch_(uuid(), { ...callbacks, default: () => 2 }))],
    ["code", () => compile(() => code(label, { in: {}, out: schema, module: "./a.ts" }))],
    ["command", () => compile(() => sh(["echo"], { label }))],
    ["wait", () => compile(() => wait(label, { payload: schema }))],
    ["subgraph", () => compile(subgraph(label, uuid))],
    ["input fields", () => loopy("reserved", { input: fields, run: () => null })],
    [
      "code inputs",
      () => compile(() => code("code", { in: { [label]: 1 }, out: schema, module: "./a.ts" })),
    ],
    [
      "output fields",
      () =>
        compile(() => code("code", { in: {}, out: { kind: "record", fields }, module: "./a.ts" })),
    ],
    ["wait fields", () => compile(() => wait("wait", { payload: { kind: "record", fields } }))],
    ["record values", () => compile(() => ({ [label]: 1 }))],
    [
      "map records",
      () =>
        loopy("map", {
          input: { items: "string[]" },
          run: ({ input }) => map(input.get("items"), () => ({ [label]: 1 }), { onError: "fail" }),
        }),
    ],
  ];

  for (const [site, callback] of cases) {
    test(`${site} rejects reserved name ${label}`, () => {
      expect(callback).toThrow(`Label "${label}" is reserved`);
    });
  }
}

test("arm dictionaries contain only own callbacks", () => {
  const arms = { own: () => 1 };
  Object.setPrototypeOf(arms, { inherited: () => fail("unused") });
  const graph = compile(() => parallel(arms));
  expect(graph.nodes[0]).toMatchObject({ branches: { own: "1:join" } });
  expect(
    graph.nodes.flatMap((node) => (node.kind === "parallel" ? Object.keys(node.branches) : [])),
  ).toEqual(["own"]);
});

test("an author reference to a parallel with one failing arm is unresolved", () => {
  const result = loopy("never-parallel-ref", {
    input: {},
    run: () => {
      const failed = parallel({ bad: () => fail("oops"), good: () => 1 });

      return log("author ref", failed);
    },
  });

  expect(result.diagnostics.map(({ code }) => code)).toEqual(["unresolved_ref"]);
  expect(result.diagnostics[0]?.node).toBe(
    result.graph.nodes.find((node) => node.kind === "log")?.id,
  );
  expect(graphTypeResolver(result.graph)({ ref: refIdSchema.parse("0:parallel"), path: [] })).toBe(
    "never",
  );
  expect(
    result.graph.nodes.find((node) => node.kind === "join" && node.scope === null),
  ).toMatchObject({ result: { kind: "none" } });
});

test("rescue resolves a parallel with one failing arm to its numeric handler", () => {
  const graph = compile(() =>
    rescue(
      () => parallel({ bad: () => fail("oops"), good: () => 1 }),
      () => 3,
    ),
  );

  const resolve = graphTypeResolver(graph);
  expect(resolve({ ref: refIdSchema.parse("1:parallel"), path: [] })).toBe("never");
  expect(resolve({ ref: refIdSchema.parse("0:rescue"), path: [] })).toBe("number");
  expect(
    graph.nodes.filter((node) => node.kind === "join" && node.result.kind === "none"),
  ).toHaveLength(2);
});

test("output shorthand and omitted schemas lower to canonical node schemas", () => {
  const parsed = defineCommand(
    { key: "custom.count", program: "count", parse: "./parse.ts" },
    "number",
  );

  const silent = defineCommand({ key: "custom.silent", program: "true" });

  const graph = compile(() => {
    code("greet", { in: {}, out: { greeting: "string" }, module: "./greet.ts" });
    wait("count", { payload: "number" });
    code("effect", { in: {}, module: "./effect.ts" });
    wait("signal");
    parsed();

    return silent();
  });

  expect(
    graph.nodes.flatMap((node) =>
      node.kind === "code" || node.kind === "command"
        ? [node.out]
        : node.kind === "wait"
          ? [node.payload]
          : [],
    ),
  ).toEqual([
    { kind: "record", fields: { greeting: "string" } },
    { kind: "value", type: "number" },
    null,
    null,
    { kind: "value", type: "number" },
    null,
  ]);
});
