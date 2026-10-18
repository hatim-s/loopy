import { CONSOLE_METHODS, RESULT_LINE_SEPARATOR } from "../core/index.js";

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
      for (const method of ${JSON.stringify(CONSOLE_METHODS)}) {
        console[method] = (...values) => log(values.map(String).join(" "));
      }
    }
    const {default: run} = await import(${JSON.stringify(module)});
    export default run;
    if (main) {
      const input = await Bun.stdin.json();
      const output = await ${invocation};
      process.stdout.write(${JSON.stringify(RESULT_LINE_SEPARATOR)} + JSON.stringify(output ?? null) + ${JSON.stringify(RESULT_LINE_SEPARATOR)});
    }
  `;
}
