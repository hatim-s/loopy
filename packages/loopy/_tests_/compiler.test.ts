import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluate } from "../src/compiler/evaluate.js";
import { compile } from "../src/compiler/index.js";
import { canonicalJson, type Json, validateGraph } from "../src/core/index.js";
import { bundleSucceeded } from "../src/executor/protocol.js";
import { compiledBody } from "./compiled-fixture.js";

const sdk = resolve(import.meta.dir, "../src/sdk/graph/index.ts");

const fixtureRoot = resolve(import.meta.dir, "fixtures/compiler");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(source: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopy-compile-test-")));
  roots.push(root);
  const file = join(root, "entry.ts");
  await writeFile(file, source.replaceAll("__SDK__", sdk));
  await writeFile(join(root, "not-function.ts"), "export default 1;");

  return { root, file };
}

const rejected = {
  "options-identifier": "options_not_literal",
  "options-wrapped": "module_default",
  "parser-inline": "module_path",
  "parameter-computed": "invalid_binding",
  "parameter-default": "invalid_binding",
  "parameter-rest": "invalid_binding",
  "unknown-sdk-call": "unknown_sdk_call",
  "parser-effect": "module_path",
  "default-export": "default_loopy",
  "duplicate-label": "duplicate_label",
  enum: "module_effect",
  namespace: "module_effect",
  async: "synchronous_run",
  await: "await_forbidden",
  if: "forbidden_statement",
  for: "forbidden_statement",
  while: "forbidden_statement",
  do: "forbidden_statement",
  switch: "forbidden_statement",
  exception: "forbidden_statement",
  template: "template_reference",
  call: "forbidden_call",
  mutable: "forbidden_statement",
  captured: "module_effect",
  label: "literal_required",
  name: "literal_required",
  key: "literal_key",
  "module-literal": "module_path",
  "module-relative": "module_path",
  "module-default": "module_default",
  "inline-function": "invalid_callback",
  spread: "literal_key",
  mutation: "forbidden_expression",
  constructor: "synchronous_run",
  "get-key": "literal_required",
} as const;

for (const [name, code] of Object.entries(rejected)) {
  test(`restrict rejects ${name} with a located stable diagnostic`, async () => {
    const { root, file } = await project(
      await Bun.file(join(fixtureRoot, "rejected", `${name}.txt`)).text(),
    );

    const result = await compile(file);
    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error("Expected compiler diagnostics.");
    }

    expect(result.diagnostics).toContainEqual({
      code,
      message: expect.any(String),
      source: {
        module: code === "module_default" ? join(root, "not-function.ts") : file,
        line: expect.any(Number),
        column: expect.any(Number),
      },
    });
    expect(
      result.diagnostics.every((value) => value.source.line > 0 && value.source.column > 0),
    ).toBe(true);
  });
}

test("restrictions traverse imported author modules before any author evaluation", async () => {
  const { root, file } = await project(
    'import {loopy} from "__SDK__"; import {value} from "./effect.ts"; export default loopy("safe", {input:{},run:()=>value});',
  );

  const marker = join(root, "ran");
  await writeFile(
    join(root, "effect.ts"),
    `Bun.write(${JSON.stringify(marker)}, "effect"); export const value=1;`,
  );
  const result = await compile(file);
  expect(result.ok).toBe(false);

  if (result.ok) {
    throw new Error("Expected compiler diagnostics.");
  }

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "module_effect",
      source: expect.objectContaining({ module: join(root, "effect.ts") }),
    }),
  );
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("subgraphs expand in each author module's directory", async () => {
  const { root, file } = await project(
    'import {loopy} from "__SDK__"; import {child} from "./child/graph.ts"; export default loopy("scoped", {input:{},run:()=>child()});',
  );

  await Bun.write(
    join(root, "child/graph.ts"),
    `import {code,subgraph} from ${JSON.stringify(sdk)}; export const child=subgraph("child",()=>code("value",{in:{},out:{kind:"value",type:"number"},module:"./value.ts"}));`,
  );
  await Bun.write(join(root, "child/value.ts"), "export default () => 1;");
  const result = await compile(file);

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  expect(result.graph.nodes[0]).toMatchObject({
    kind: "code",
    module: { path: join(root, "child/value.ts") },
  });
});

for (const effect of ["network", "write"]) {
  test(`evaluation sandbox denies ${effect} even if AST validation is bypassed`, async () => {
    const { root, file } = await project("export default {};");
    const outside = `${root}-outside`;
    roots.push(outside);

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reachable"),
    });

    const graph = JSON.stringify((await compiledBody("isolated", file)).graph);

    const source =
      effect === "network"
        ? `await fetch(${JSON.stringify(server.url.toString())}); export default {graph:${graph}};`
        : `await Bun.write(${JSON.stringify(outside)}, "escaped"); export default {graph:${graph}};`;

    await writeFile(file, source);

    try {
      expect(await evaluate(file, [{ file, source, evaluated: source }])).toMatchObject({
        ok: false,
        diagnostics: [{ code: "evaluation_failed" }],
      });
    } finally {
      await server.stop(true);
    }

    expect(await Bun.file(outside).exists()).toBe(false);
  });
}

test("compiler sandbox denies reads of daemon secrets inside the workspace", async () => {
  const { root, file } = await project("export default {};");
  const graph = JSON.stringify((await compiledBody("isolated", file)).graph);
  const home = join(root, "home");
  const secrets = join(home, "secrets.json");
  await Bun.write(secrets, '{"TOKEN":"private"}');
  const source = `await Bun.file(${JSON.stringify(secrets)}).text(); export default {graph:${graph}};`;
  await writeFile(file, source);
  expect(await evaluate(file, [{ file, source, evaluated: source }], home)).toMatchObject({
    ok: false,
    diagnostics: [
      {
        code: "evaluation_failed",
        message: expect.stringMatching(/permitted|denied|EACCES|EPERM/i),
      },
    ],
  });
});

test("evaluation has a hard ten second timeout", async () => {
  const { file } = await project("while(true){} export default {};");
  const source = await Bun.file(file).text();
  const started = performance.now();
  expect(await evaluate(file, [{ file, source, evaluated: source }])).toMatchObject({
    ok: false,
    diagnostics: [
      { code: "evaluation_failed", message: expect.stringContaining("timed out after 10000 ms") },
    ],
  });
  expect(performance.now() - started).toBeLessThan(12_000);
}, 15_000);

test("bundle hashes are stable, code changes alter revisions and whitespace does not", async () => {
  const { root, file } = await project(
    'import {loopy,code,fs} from "__SDK__"; export default loopy("hashes", {input:{},run:()=>{fs.ls();return code("value",{in:{},out:{kind:"value",type:"number"},module:"./value.ts"});}});',
  );

  const module = join(root, "value.ts");
  await writeFile(module, "export default () => 1;");
  const first = await compile(file);
  const second = await compile(file);

  if (!first.ok || !second.ok) {
    throw new Error(JSON.stringify({ first, second }));
  }

  expect(first.bundles.map((value) => value.bundleHash)).toEqual(
    second.bundles.map((value) => value.bundleHash),
  );
  expect(first.revision).toBe(second.revision);
  await writeFile(module, "\n// whitespace\nexport default  ( ) => 1 ;\n");
  await writeFile(file, `\n${await Bun.file(file).text()}\n`);
  const whitespace = await compile(file);

  if (!whitespace.ok) {
    throw new Error(JSON.stringify(whitespace.diagnostics));
  }

  expect(whitespace.revision).toBe(first.revision);
  await writeFile(module, "export default () => 2;");
  const changed = await compile(file);

  if (!changed.ok) {
    throw new Error(JSON.stringify(changed.diagnostics));
  }

  expect(changed.revision).not.toBe(first.revision);
  expect(first.bundles).toHaveLength(2);
});

test("parser module bundles are hashed and preserve their module bindings", async () => {
  const { root, file } = await project(
    'import {loopy,defineCommand} from "__SDK__"; const cmd=defineCommand({key:"custom",program:"echo",parse:"./parse.ts"},{kind:"value",type:"string"}); export default loopy("parser", {input:{},run:()=>cmd()});',
  );

  await writeFile(
    join(root, "parse.ts"),
    'const suffix="!"; export default (result: {stdout:string}) => result.stdout.trim()+suffix;',
  );
  const result = await compile(file);

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  const bundle = result.bundles[0];

  if (!bundle) {
    throw new Error("Missing parser bundle.");
  }

  const path = join(root, "parser.js");
  await writeFile(path, bundle.bytes);
  const { default: parse }: { default: (input: { stdout: string }) => string } = await import(path);
  expect(parse({ stdout: "hello\n" })).toBe("hello!");
  expect(result.graph.nodes[0]).toMatchObject({
    kind: "command",
    parse: { bundleHash: bundle.bundleHash },
  });
});

for (const name of ["hello", "review", "asset-sync", "www-sync"]) {
  test(`compile the ${name} graph example with its module and parser bundles`, async () => {
    const result = await compile(resolve(import.meta.dir, `fixtures/graph-examples/${name}.ts`));

    if (!result.ok) {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    expect(validateGraph(result.graph)).toEqual([]);
    expect(result.bundles.length).toBeGreaterThan(0);
  });
}

test("canonical JSON sorts nested keys and preserves array order", () => {
  expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: null })).toBe('{"a":null,"z":[{"a":1,"b":2}]}');
});

test("code bundle import.meta names each source module instead of the saved bundle", async () => {
  const { root, file } = await project(
    'import {loopy,code} from "__SDK__"; export default loopy("paths", {input:{},run:()=>code("paths",{in:{},out:{kind:"record",fields:{entry:"string",helper:"string"}},module:"./code.ts"})});',
  );

  await writeFile(
    join(root, "code.ts"),
    'import {helper} from "./lib/helper.ts"; export default () => ({entry:import.meta.path,helper});',
  );
  await Bun.write(join(root, "lib/helper.ts"), "export const helper = import.meta.path;");
  const result = await compile(file);

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  const bundle = result.bundles[0];

  if (!bundle) {
    throw new Error("Missing code bundle.");
  }

  const saved = join(root, "saved.js");
  await writeFile(saved, bundle.bytes);

  const { default: run }: { default: () => { entry: string; helper: string } } = await import(
    saved
  );

  expect(run()).toEqual({ entry: join(root, "code.ts"), helper: join(root, "lib/helper.ts") });
});

test("bundles execute the stdin/stdout protocol and preserve prepared parser input", async () => {
  const { root, file } = await project(
    'import {loopy,defineCommand,code} from "__SDK__"; const command=defineCommand({namespace:"custom",name:"parse",program:"echo",flags:{suffix:{cli:"-s",kind:"string"}},parse:"./parse.ts"},{kind:"value",type:"string"}); export default loopy("executable", {input:{},run:()=>{command({args:["hello"],flags:{suffix:"!"}});return code("context",{in:{value:42},out:{kind:"record",fields:{value:"number",workspace:"string"}},module:"./context.ts"});}});',
  );

  await writeFile(
    join(root, "parse.ts"),
    "export default (result,input)=>result.stdout.trim()+input.args[0]+input.flags.suffix;",
  );
  await writeFile(
    join(root, "context.ts"),
    'console.log("module loaded"); export default (input,context)=>{context.log("ready",{value:input.value}); console.log("captured"); console.debug("debug"); console.trace("trace"); console.table("table"); console.dir("dir"); process.stdout.write("author noise\\npartial"); return {value:input.value,workspace:context.workspace};};',
  );
  const compiled = await compile(file);

  if (!compiled.ok) {
    throw new Error(JSON.stringify(compiled.diagnostics));
  }

  const command = compiled.graph.nodes.find((node) => node.kind === "command");
  expect(command?.parse?.input).toEqual({ args: ["hello"], flags: { suffix: "!" } });

  const execute = async (index: number, input: Json) => {
    const bundle = compiled.bundles[index];

    if (!bundle) {
      throw new Error("Missing bundle.");
    }

    const path = join(root, `bundle-${index}.js`);
    await writeFile(path, bundle.bytes);

    const child = Bun.spawn([process.execPath, path], {
      cwd: root,
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(code).toBe(0);

    return { stdout, stderr };
  };

  const parsed = await execute(0, {
    result: { stdout: "output\n", stderr: "", exitCode: 0, durationMs: 1 },
    input: command?.parse?.input ?? {},
  });

  expect(JSON.parse(parsed.stdout)).toBe("outputhello!");
  const result = await execute(1, { value: 42 });
  expect(
    bundleSucceeded(
      { stdout: result.stdout, stderr: "", exitCode: 0, durationMs: 0 },
      { complete: (text) => text, fragment: (text) => text },
    ),
  ).toEqual({
    kind: "succeeded",
    output: { value: 42, workspace: root },
    logs: [{ message: "stdout", data: "author noise\npartial\n" }],
  });

  const logs = result.stderr
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  for (const message of ["debug", "trace", "table", "dir"]) {
    expect(logs).toContainEqual({ message, data: null });
  }

  expect(result.stderr).toContain('"message":"ready"');
  expect(result.stderr).toContain('"message":"captured"');
  expect(result.stderr).toContain('"message":"module loaded"');
});

for (const name of [
  "import-meta-helper",
  "require-helper",
  "transitive-helper",
  "absolute-helper",
]) {
  test(`code modules reject ${name} with a located dynamic_code diagnostic`, async () => {
    const { root, file } = await project(
      'import {loopy,code} from "__SDK__";export default loopy("dynamic",{input:{},run:()=>code("x",{in:{},out:{kind:"value",type:"number"},module:"./code.ts"})});',
    );

    await writeFile(
      join(root, "code.ts"),
      (await Bun.file(join(fixtureRoot, "modules", `${name}.txt`)).text()).replace(
        "__HELPER__",
        join(root, "helper.ts"),
      ),
    );
    await writeFile(
      join(root, "helper.ts"),
      'export const value=()=>import(import.meta.dir + "/escaped.ts");',
    );
    const result = await compile(file);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "dynamic_code",
          source: {
            module: join(
              root,
              name.endsWith("transitive-helper") || name === "absolute-helper"
                ? "helper.ts"
                : "code.ts",
            ),
            line: 1,
            column: expect.any(Number),
          },
        }),
      ],
    });
  });
}

test("literal dynamic imports are bundled and alter the pinned revision", async () => {
  const { root, file } = await project(
    'import {loopy,code} from "__SDK__";export default loopy("literal",{input:{},run:()=>code("x",{in:{},out:{kind:"value",type:"number"},module:"./code.ts"})});',
  );

  await writeFile(
    join(root, "code.ts"),
    'export default async () => (await import("./helper.ts")).value;',
  );
  await writeFile(join(root, "helper.ts"), "export const value=1;");
  const first = await compile(file);
  await writeFile(join(root, "helper.ts"), "export const value=2;");
  const second = await compile(file);

  if (!first.ok || !second.ok) {
    throw new Error(JSON.stringify({ first, second }));
  }

  expect(first.revision).not.toBe(second.revision);
  await writeFile(join(root, "pinned.js"), first.bundles[0]?.bytes ?? new Uint8Array());
  await rm(join(root, "helper.ts"));

  const { default: run }: { default: () => Promise<number> } = await import(
    join(root, "pinned.js")
  );

  expect(await run()).toBe(1);
});

test("parser modules reject dynamic imports in their local dependencies", async () => {
  const { root, file } = await project(
    'import {loopy,defineCommand} from "__SDK__";const cmd=defineCommand({key:"custom",program:"echo",parse:"./parse.ts"},{kind:"value",type:"number"});export default loopy("parser",{input:{},run:()=>cmd()});',
  );

  await writeFile(
    join(root, "parse.ts"),
    'import {value} from "./helper.ts";export default ()=>value();',
  );
  await writeFile(
    join(root, "helper.ts"),
    'export const value=()=>import(import.meta.dir+"/escaped.ts");',
  );
  const result = await compile(file);
  expect(result).toMatchObject({
    ok: false,
    diagnostics: [
      expect.objectContaining({
        code: "dynamic_code",
        source: expect.objectContaining({ module: join(root, "helper.ts") }),
      }),
    ],
  });
});

for (const wrapper of [
  "({options} as const)",
  "({options} satisfies object)",
  "({options})!",
  "((({options})))",
]) {
  test(`options retain module validation through ${wrapper}`, async () => {
    const options = wrapper.replace(
      "{options}",
      '{in:{},out:{kind:"value",type:"number"},module:"./not-function.ts"}',
    );

    const { file } = await project(
      `import {loopy,code} from "__SDK__";export default loopy("wrapped",{input:{},run:()=>code("x",${options})});`,
    );

    const result = await compile(file);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "module_default" })],
    });
  });
}

for (const expression of [
  "import(path)",
  "require(path)",
  "new Function(path)()",
  "eval(path)",
  "import.meta.require(path)",
  "(0, eval)(path)",
  "globalThis.Function(path)()",
  "globalThis.require?.(path)",
  "new globalThis.AsyncFunction(path)()",
  "globalThis.GeneratorFunction(path)()",
  "globalThis.createRequire(path)",
  "globalThis.importSync(path)",
  "globalThis.import(path)",
  "import.meta.resolve(path)",
  "Bun.plugin({setup() {}})",
  "new Bun.Transpiler()",
]) {
  test(`emitted bundle rejects ${expression} in a tsconfig alias dependency`, async () => {
    const { root, file } = await project(
      'import {loopy,code} from "__SDK__";export default loopy("alias",{input:{},run:()=>code("x",{in:{path:"./escaped.ts"},out:{kind:"value",type:"number"},module:"./code.ts"})});',
    );

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@local/*": ["./lib/*"] } } }),
    );
    await writeFile(
      join(root, "code.ts"),
      'import {value} from "@local/helper";export default ({path})=>value(path);',
    );
    await Bun.write(join(root, "lib/helper.ts"), `export const value=(path)=>${expression};`);

    const result = await compile(file);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "dynamic_code",
          source: {
            module: join(root, "code.ts"),
            line: expect.any(Number),
            column: expect.any(Number),
          },
        }),
      ],
    });
  });
}

test("tsconfig alias helpers are bundled and their changes alter the hash and revision", async () => {
  const { root, file } = await project(
    'import {loopy,code} from "__SDK__";export default loopy("alias",{input:{},run:()=>code("x",{in:{},out:{kind:"value",type:"number"},module:"./code.ts"})});',
  );

  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "@local/*": ["./lib/*"] } } }),
  );
  await writeFile(
    join(root, "code.ts"),
    'import {value} from "@local/helper";export default ()=>value;',
  );
  const helper = join(root, "lib/helper.ts");
  await Bun.write(helper, "export const value=1;");
  const first = await compile(file);
  await writeFile(helper, "export const value=2;");
  const second = await compile(file);

  if (!first.ok || !second.ok) {
    throw new Error(JSON.stringify({ first, second }));
  }

  expect(first.bundles[0]?.bundleHash).not.toBe(second.bundles[0]?.bundleHash);
  expect(first.revision).not.toBe(second.revision);
  const saved = join(root, "pinned.js");
  await writeFile(saved, first.bundles[0]?.bytes ?? new Uint8Array());
  await rm(helper);
  const { default: run }: { default: () => number } = await import(saved);
  expect(run()).toBe(1);
});

test("node_modules dependencies with literal dynamic imports bundle their helpers", async () => {
  const { root, file } = await project(
    'import {loopy,code} from "__SDK__";export default loopy("dependency",{input:{},run:()=>code("x",{in:{},out:{kind:"value",type:"number"},module:"./code.ts"})});',
  );

  await writeFile(
    join(root, "code.ts"),
    'import {value} from "literal-dependency";export default ()=>value();',
  );
  const dependency = join(root, "node_modules/literal-dependency");
  await Bun.write(
    join(dependency, "package.json"),
    JSON.stringify({ name: "literal-dependency", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(dependency, "index.js"),
    'export const value=async ()=>(await import("./helper.js")).value;',
  );
  await writeFile(join(dependency, "helper.js"), "export const value=42;");
  const result = await compile(file);

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  const saved = join(root, "pinned.js");
  await writeFile(saved, result.bundles[0]?.bytes ?? new Uint8Array());
  await rm(join(root, "node_modules"), { recursive: true });
  const { default: run }: { default: () => Promise<number> } = await import(saved);
  expect(await run()).toBe(42);
});

test("the public SDK entry compiles through the same graph builder", async () => {
  const f = await project(
    'import {loopy,log} from "loopy"; export default loopy("public-entry", {input: {}, run: () => {log("hello"); return 1;}});',
  );

  const result = await compile(f.file);
  expect(result.ok).toBe(true);

  if (result.ok) {
    expect(result.graph.nodes.map((node) => node.kind)).toEqual(["log", "join"]);
  }
});
