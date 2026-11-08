import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compile, project } from "./fixtures/compile";

const fixtureRoot = resolve(import.meta.dir, "fixtures");

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
      file: code === "module_default" ? join(root, "not-function.ts") : file,
      line: expect.any(Number),
      column: expect.any(Number),
    });
    expect(result.diagnostics.every((value) => value.line > 0 && value.column > 0)).toBe(true);
  });
}

test("restrictions traverse imported author modules before any author evaluation", async () => {
  const { root, file } = await project(
    'import {loopy} from "loopy"; import {value} from "./effect.ts"; export default loopy("safe", {input:{},run:()=>value});',
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
    expect.objectContaining({ code: "module_effect", file: join(root, "effect.ts") }),
  );
  expect(await Bun.file(marker).exists()).toBe(false);
});

for (const name of [
  "import-meta-helper",
  "require-helper",
  "transitive-helper",
  "absolute-helper",
]) {
  test(`code modules reject ${name} with a located dynamic_code diagnostic`, async () => {
    const { root, file } = await project(
      'import {loopy,code} from "loopy";export default loopy("dynamic",{input:{},run:()=>code("x",{in:{},out:{kind:"value",type:"number"},module:"./code.ts"})});',
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
          file: join(
            root,
            name.endsWith("transitive-helper") || name === "absolute-helper"
              ? "helper.ts"
              : "code.ts",
          ),
          line: 1,
          column: expect.any(Number),
        }),
      ],
    });
  });
}

test("parser modules reject dynamic imports in their local dependencies", async () => {
  const { root, file } = await project(
    'import {loopy,defineCommand} from "loopy";const cmd=defineCommand({key:"custom",program:"echo",parse:"./parse.ts"},{kind:"value",type:"number"});export default loopy("parser",{input:{},run:()=>cmd()});',
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
    diagnostics: [expect.objectContaining({ code: "dynamic_code", file: join(root, "helper.ts") })],
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
      `import {loopy,code} from "loopy";export default loopy("wrapped",{input:{},run:()=>code("x",${options})});`,
    );

    const result = await compile(file);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "module_default" })],
    });
  });
}

for (const specifier of ["@loopy/sdk", "loopy/graph"]) {
  test(`author builders reject ${specifier}`, async () => {
    const { file } = await project(
      `import {loopy} from ${JSON.stringify(specifier)}; export default loopy("private-sdk", {input: {}, run: () => 1});`,
    );

    const result = await compile(file);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "module_import" })]),
    });
  });
}

for (const specifier of ["./missing", "not-a-real-loopy-fixture-package"]) {
  test(`unresolved author import ${specifier} remains diagnostic data`, async () => {
    const { root, file } = await project(
      'import {loopy,code} from "loopy";export default loopy("broken",{input:{},run:()=>code("x",{in:{},out:{kind:"value",type:"number"},module:"./code.ts"})});',
    );

    await writeFile(
      join(root, "code.ts"),
      `import {value} from ${JSON.stringify(specifier)};export default ()=>value;`,
    );
    const result = await compile(file);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: specifier.startsWith(".") ? "source_error" : "bundle_failed",
          message: expect.stringContaining(specifier.replace("./", "")),
        }),
      ],
    });
  });
}

test("a missing builder dependency remains a source diagnostic", async () => {
  const { file } = await project('import {missing} from "./missing";export default missing;');
  expect(await compile(file)).toMatchObject({
    ok: false,
    diagnostics: [
      expect.objectContaining({
        code: "source_error",
        message: expect.stringContaining("missing"),
      }),
    ],
  });
});

test("a label key is ordinary data outside command options, and label flags compile", async () => {
  const { root, file } = await project(
    'import {loopy,code,defineCommand} from "loopy"; const gh=defineCommand({key:"gh.issue",program:"gh",flags:{label:{cli:"--label",kind:"string",repeatable:true}}}); export default loopy("labels", {input:{name:"string"},run:({input})=>{gh({flags:{label:[input.get("name")]}},{label:"tag"});return code("step",{in:{label:input.get("name")},out:{kind:"value",type:"string"},module:"./step.ts"});}});',
  );

  await writeFile(join(root, "step.ts"), "export default (input) => input.label;");
  const result = await compile(file);

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  expect(result.graph.nodes.slice(0, 2).map((node) => node.label)).toEqual(["tag", "step"]);
});
