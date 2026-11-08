import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Json, validateGraph } from "@loopy/core";
import { bundleResult } from "@loopy/runtime/executor/protocol";
import { compile, project } from "./fixtures/compile";

// The executor's own decoder, so these tests read bundle stdout exactly as a run does.
const decodeStdout = (stdout: string) =>
  bundleResult({ stdout, stderr: "", exitCode: 0 }, (text) => text);

test("the same loopy compiled from two checkout locations has one revision", async () => {
  const compileCopy = async () => {
    const { root, file } = await project(
      'import {loopy,defineCommand,code} from "loopy"; const echo=defineCommand({key:"custom.echo",program:"echo",parse:"./parse.ts"},{kind:"value",type:"string"}); export default loopy("moved", {input:{},run:()=>code("value",{in:{word:echo({args:["hi"]})},out:{kind:"value",type:"string"},module:"./lib/value.ts"})});',
    );

    await writeFile(join(root, "parse.ts"), "export default (result)=>result.stdout.trim();");
    await Bun.write(join(root, "lib/value.ts"), "export default (input)=>input.word;");
    const compiled = await compile(file);

    if (!compiled.ok) {
      throw new Error(JSON.stringify(compiled.diagnostics));
    }

    return compiled;
  };

  const [first, second] = [await compileCopy(), await compileCopy()];
  expect(first.revision).toBe(second.revision);
  expect(
    first.graph.nodes.flatMap((node) => (node.kind === "code" ? [node.module.path] : [])),
  ).toEqual(["lib/value.ts"]);
});

test("bundle hashes are stable, code changes alter revisions and whitespace does not", async () => {
  const { root, file } = await project(
    'import {loopy,code,fs} from "loopy"; export default loopy("hashes", {input:{},run:()=>{fs.ls();return code("value",{in:{},out:{kind:"value",type:"number"},module:"./value.ts"});}});',
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
    'import {loopy,defineCommand} from "loopy"; const cmd=defineCommand({key:"custom",program:"echo",parse:"./parse.ts"},{kind:"value",type:"string"}); export default loopy("parser", {input:{},run:()=>cmd()});',
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

for (const [name, graphName] of [
  ["hello", "hello"],
  ["review", "review"],
  ["asset-sync", "uacode-asset-sync"],
  ["www-sync", "www-uacode-sync"],
] as const) {
  test(`compile the ${name} graph example with its module and parser bundles`, async () => {
    const result = await compile(
      resolve(import.meta.dir, `../../sdk/_tests_/fixtures/graph-examples/${name}.ts`),
    );

    if (!result.ok) {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    expect(validateGraph(result.graph)).toEqual([]);
    expect(result.graph.name).toBe(graphName);
    expect(result.bundles.length).toBeGreaterThan(0);
  });
}

test("code bundle import.meta names each source module instead of the saved bundle", async () => {
  const { root, file } = await project(
    'import {loopy,code} from "loopy"; export default loopy("paths", {input:{},run:()=>code("paths",{in:{},out:{kind:"record",fields:{entry:"string",helper:"string"}},module:"./code.ts"})});',
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

test("parser and code bundles execute and return output", async () => {
  const { root, file } = await project(
    'import {loopy,defineCommand,code} from "loopy"; const command=defineCommand({key:"custom.parse",program:"echo",flags:{suffix:{cli:"-s",kind:"string"}},parse:"./parse.ts"},{kind:"value",type:"string"}); export default loopy("executable", {input:{},run:()=>{command({args:["hello"],flags:{suffix:"!"}});return code("context",{in:{value:42},out:{kind:"record",fields:{value:"number",workspace:"string"}},module:"./context.ts"});}});',
  );

  await writeFile(
    join(root, "parse.ts"),
    "export default (result)=>result.stdout.trim()+result.exitCode;",
  );
  await writeFile(
    join(root, "context.ts"),
    "export default (input,context)=>({value:input.value,workspace:context.workspace});",
  );
  const compiled = await compile(file);

  if (!compiled.ok) {
    throw new Error(JSON.stringify(compiled.diagnostics));
  }

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
    });

    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    expect(code).toBe(0);

    return { stdout };
  };

  const parsed = await execute(0, { stdout: "output\n", stderr: "", exitCode: 0 });

  expect(JSON.parse(parsed.stdout)).toBe("output0");
  const result = await execute(1, { value: 42 });
  expect(decodeStdout(result.stdout)).toMatchObject({
    kind: "succeeded",
    output: { value: 42, workspace: root },
  });
});

test("literal dynamic imports are bundled and alter the pinned revision", async () => {
  const { root, file } = await project(
    'import {loopy,code} from "loopy";export default loopy("literal",{input:{},run:()=>code("x",{in:{},out:{kind:"value",type:"number"},module:"./code.ts"})});',
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
      'import {loopy,code} from "loopy";export default loopy("alias",{input:{},run:()=>code("x",{in:{path:"./escaped.ts"},out:{kind:"value",type:"number"},module:"./code.ts"})});',
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
          file: join(root, "code.ts"),
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ],
    });
  });
}

test("tsconfig alias helpers are bundled and their changes alter the hash and revision", async () => {
  const { root, file } = await project(
    'import {loopy,code} from "loopy";export default loopy("alias",{input:{},run:()=>code("x",{in:{},out:{kind:"value",type:"number"},module:"./code.ts"})});',
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
    'import {loopy,code} from "loopy";export default loopy("dependency",{input:{},run:()=>code("x",{in:{},out:{kind:"value",type:"number"},module:"./code.ts"})});',
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
