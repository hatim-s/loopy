// Bun folds import.meta.main for virtual entrypoints, so the bundle compares its runtime path.
export function runnerSource(module: string, kind: "code" | "parser") {
  const invocation =
    kind === "code"
      ? "run(input, { workspace: process.cwd(), log })"
      : "run(input.result, input.input)";

  return `
    import {fileURLToPath} from "node:url";
    const main = process.argv[1] === fileURLToPath(import.meta.url);
    const log = (message, data = null) => process.stderr.write(JSON.stringify({message, data}) + "\\n");
    if (main) {
      console.log = (...values) => log(values.map(String).join(" "));
      console.info = console.log;
      console.warn = console.log;
      console.error = console.log;
    }
    const {default: run} = await import(${JSON.stringify(module)});
    export default run;
    if (main) {
      const input = await Bun.stdin.json();
      const output = await ${invocation};
      process.stdout.write(JSON.stringify(output ?? null));
    }
  `;
}
