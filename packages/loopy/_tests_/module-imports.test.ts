import { expect, test } from "bun:test";
import { checkImports } from "../src/compiler/code-module.js";
import type { CompilerDiagnostic } from "../src/compiler/types.js";

function diagnosticsFor(source: string) {
  const diagnostics: CompilerDiagnostic[] = [];
  checkImports("bundle.ts", source, diagnostics);

  return diagnostics;
}

for (const name of [
  "require",
  "eval",
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "createRequire",
  "importSync",
  "import",
]) {
  for (const expression of [
    `${name}(path)`,
    `globalThis.${name}(path)`,
    `other["${name}"](path)`,
    `(0, globalThis.${name})(path)`,
    `other.${name}?.(path)`,
    `new other.${name}(path)`,
  ]) {
    test(`runtime code denylist rejects ${expression}`, () => {
      expect(diagnosticsFor(expression)).toContainEqual({
        code: "dynamic_code",
        file: "bundle.ts",
        line: 1,
        column: expect.any(Number),
        message: "Use bundled modules instead of runtime loading or code generation.",
      });
    });
  }
}

for (const expression of [
  "import.meta.require(path)",
  "import.meta.resolve(path)",
  'import.meta["require"]?.("./literal.js")',
  '(0, import.meta.resolve)("./literal.js")',
  "(0, eval)(path)",
  "globalThis.Function(path)()",
  'eval("source")',
  'new Function("source")',
  "Bun.plugin",
  'Bun["plugin"]',
  "Bun?.Transpiler",
  "new Bun.Transpiler()",
  'import { plugin as register } from "bun";',
  'import { Transpiler } from "bun";',
  'import * as runtime from "bun"; runtime.plugin;',
  'import runtime from "bun"; runtime.Transpiler;',
  "const loader = import.meta.require; loader(path);",
]) {
  test(`runtime code denylist rejects ${expression}`, () => {
    expect(diagnosticsFor(expression)).toContainEqual(
      expect.objectContaining({ code: "dynamic_code" }),
    );
  });
}

for (const module of [
  "vm",
  "node:vm",
  "module",
  "node:module",
  "worker_threads",
  "node:worker_threads",
]) {
  for (const source of [
    `import * as runtime from "${module}";`,
    `export * from "${module}";`,
    `export { value } from "${module}";`,
    `import("${module}");`,
    `require("${module}");`,
  ]) {
    test(`runtime code denylist rejects ${source}`, () => {
      expect(diagnosticsFor(source)).toContainEqual(
        expect.objectContaining({ code: "dynamic_code" }),
      );
    });
  }
}

for (const source of [
  'import("./helper.js")',
  'require("./helper.js")',
  'import { readFile } from "node:fs/promises";',
  'import { spawn } from "node:child_process";',
  'import { file } from "bun";',
  'import type { Transpiler } from "bun";',
  "other.plugin()",
  "other.Transpiler()",
  "object[require](path)",
]) {
  test(`runtime code denylist allows ${source}`, () => {
    expect(diagnosticsFor(source)).toEqual([]);
  });
}
