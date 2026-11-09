import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { Schema } from "effect";
import * as ts from "typescript";

const root = resolve(import.meta.dir, "..");

const packages = resolve(root, "packages");

const packageDist = resolve(packages, "loopy/dist");

const manifestSchema = Schema.Struct({
  name: Schema.String,
  exports: Schema.Record(Schema.String, Schema.String),
});

async function vendoredPackages() {
  const entries = await readdir(packages, { withFileTypes: true });

  return entries.flatMap((entry) =>
    entry.isDirectory() && entry.name !== "loopy" ? [entry.name] : [],
  );
}

async function packageExports(vendored: readonly string[]) {
  const exports = new Map<string, string>();

  for (const name of vendored) {
    const manifest: unknown = await Bun.file(resolve(packages, name, "package.json")).json();

    const decoded = Schema.decodeUnknownSync(manifestSchema)(manifest);

    for (const [subpath, target] of Object.entries(decoded.exports)) {
      const specifier = decoded.name + (subpath === "." ? "" : subpath.slice(1));
      exports.set(specifier, relative(packages, resolve(packages, name, target)));
    }
  }

  return exports;
}

function moduleSpecifier(node: ts.StringLiteral) {
  const parent = node.parent;

  return (
    ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === node) ||
    (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
    (ts.isCallExpression(parent) &&
      parent.arguments[0] === node &&
      (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isPropertyAccessExpression(parent.expression) &&
          parent.expression.getText() === "Bun.resolveSync")))
  );
}

async function rewriteModules(directory: string, exports: Map<string, string>) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      await rewriteModules(file, exports);
      continue;
    }

    if (!file.endsWith(".js") && !file.endsWith(".d.ts")) {
      continue;
    }

    const source = await Bun.file(file).text();
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const edits: { start: number; end: number; text: string }[] = [];
    const declarations = file.endsWith(".d.ts");

    function visit(node: ts.Node) {
      if (ts.isStringLiteral(node) && moduleSpecifier(node) && node.text.startsWith("@loopy/")) {
        const target = exports.get(node.text);

        if (!target) {
          throw new Error(`Unknown private package export '${node.text}' in ${file}`);
        }

        const emitted = target.replace(/\.tsx?$/, ".js");
        const targetFile = resolve(packageDist, declarations ? "types" : ".", emitted);
        const path = relative(dirname(file), targetFile);
        edits.push({
          start: node.getStart(parsed),
          end: node.getEnd(),
          text: JSON.stringify(path.startsWith(".") ? path : `./${path}`),
        });
      }

      ts.forEachChild(node, visit);
    }

    visit(parsed);

    if (edits.length > 0) {
      const rewritten = edits
        .sort((a, b) => b.start - a.start)
        .reduce(
          (text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end),
          source,
        );

      await Bun.write(file, rewritten);
    }
  }
}

await rm(packageDist, { recursive: true, force: true });

const vendored = await vendoredPackages();

const exports = await packageExports(vendored);

const config = resolve(packages, `loopy/.tsconfig.build.generated-${process.pid}.json`);

const paths = Object.fromEntries(
  [...exports].map(([specifier, target]) => [specifier, [`../${target}`]]),
);

await Bun.write(
  config,
  JSON.stringify({
    extends: "./tsconfig.build.json",
    compilerOptions: { paths },
    include: ["src", ...vendored.map((name) => `../${name}/src`)],
  }),
);

try {
  // TypeScript 7 is installed as @typescript/native beside the TypeScript 6 JS API that
  // typescript-eslint and this script's AST walk need; both packages ship a `tsc` bin.
  const tsc = resolve(root, "node_modules/@typescript/native/bin/tsc");

  const compiled = Bun.spawn([process.execPath, tsc, "-p", config], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });

  if ((await compiled.exited) !== 0) {
    throw new Error("Package JavaScript and declaration build failed");
  }
} finally {
  await rm(config, { force: true });
}

await rewriteModules(packageDist, exports);

const dashboard = Bun.spawn([process.execPath, "run", "--cwd", "apps/dashboard", "build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});

if ((await dashboard.exited) !== 0) {
  throw new Error("Dashboard build failed");
}

await mkdir(packageDist, { recursive: true });

await cp(resolve(root, "apps/dashboard/dist"), resolve(packageDist, "dashboard"), {
  recursive: true,
});

await cp(resolve(root, "LICENSE"), resolve(packages, "loopy/LICENSE"));

await cp(resolve(root, "README.md"), resolve(packages, "loopy/README.md"));

await chmod(resolve(packageDist, "cli/src/index.js"), 0o755);

console.log("Built loopy with vendored workspace modules and the dashboard.");
