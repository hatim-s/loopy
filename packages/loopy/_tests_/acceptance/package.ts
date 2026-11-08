import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";

const repository = resolve(import.meta.dir, "../../../..");

// The consumer typechecks with the same effect-tsgo and TypeScript 7 builds the repository pins.
const { devDependencies: pinned } = Schema.decodeUnknownSync(
  Schema.Struct({
    devDependencies: Schema.Struct({
      "@effect/tsgo": Schema.String,
      "@typescript/native": Schema.String,
      "bun-types": Schema.String,
    }),
  }),
)(await Bun.file(join(repository, "package.json")).json());

async function assertPrivateImportsAbsent(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);

    if (entry.isDirectory()) {
      await assertPrivateImportsAbsent(file);
    } else if (file.endsWith(".js") || file.endsWith(".d.ts")) {
      const source = await Bun.file(file).text();

      if (
        /(?:from\s*|import\s*(?:\(\s*)?|Bun\.resolveSync\(\s*|import\.meta\.resolve\(\s*)["']@loopy\//.test(
          source,
        )
      ) {
        throw new Error(`Packed file still references a private package: ${file}`);
      }
    }
  }
}

async function verifyPackedDistribution() {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "loopy-package-")));
  const home = join(fixture, "home");

  const environment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: fixture,
    TMPDIR: fixture,
    LOOPY_HOME: home,
  };

  async function run(args: string[], cwd = fixture) {
    const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
      cwd,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => child.kill(), 120_000);

    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      if (code !== 0) {
        throw new Error(`${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
      }

      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const archive = join(fixture, "loopy.tgz");
    await run(
      ["pm", "pack", "--ignore-scripts", "--filename", archive],
      join(repository, "packages/loopy"),
    );
    await Bun.write(
      join(fixture, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { loopy: `file:${archive}` },
        devDependencies: pinned,
      }),
    );
    await run(["install", "--ignore-scripts"]);
    await mkdir(join(fixture, ".loopy/loopies"), { recursive: true });
    await mkdir(join(fixture, "listing"));
    await assertPrivateImportsAbsent(join(fixture, "node_modules/loopy/dist"));
    await Bun.write(
      join(fixture, "consumer.ts"),
      `
import {loopy} from "loopy";
import type {Ref} from "loopy/graph";
import * as contract from "loopy/contract";
import * as engine from "loopy/engine";
import * as local from "loopy/local";
const definition = loopy("typed-package", {input: {}, run: () => 42});
const value: Ref<number> | undefined = undefined;
void [definition, value, contract, engine, local];
`,
    );
    await run([
      "node_modules/.bin/effect-tsgo",
      "tsc",
      "--noEmit",
      "--strict",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--target",
      "ES2022",
      "--types",
      "bun-types",
      "consumer.ts",
    ]);
    await Bun.write(
      join(fixture, "entry.ts"),
      `
import {loopy, fs, code} from "loopy";
export default loopy("packed", {input: {}, run: () => {
  fs.ls({args: ["./listing"]});
  return code("answer", {in: {}, out: {kind: "value", type: "number"}, module: "./answer.ts"});
}});
`,
    );
    await Bun.write(join(fixture, "answer.ts"), "export default () => 42;");
    await run([
      "node_modules/loopy/dist/cli/src/index.js",
      "--home",
      home,
      "--cwd",
      fixture,
      "graph",
      "entry.ts",
    ]);
    await Bun.write(
      join(fixture, "execute.ts"),
      Bun.file(join(import.meta.dir, "packed-consumer.ts")),
    );
    console.log(await run(["execute.ts", home, fixture]));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

await verifyPackedDistribution();
