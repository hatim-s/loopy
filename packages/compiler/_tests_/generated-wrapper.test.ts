import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { qualityTestRoot } from "../../runtime/_tests_/fixtures/quality-test-root";
import { parseCliHelp } from "../../runtime/src/local/typegen/parse-help";
import { renderCommandSource } from "../../runtime/src/local/typegen/render";
import { compileOrThrow } from "./fixtures/compile";

const help = `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]

Arguments:
  [PROMPT]  Initial instructions

Options:
      --json  Print events as JSONL
`;

test("a generated wrapper compiles into a saved graph's command node", async () => {
  const directory = qualityTestRoot("generated");

  await writeFile(
    join(directory, "codex.ts"),
    renderCommandSource("codexExec", parseCliHelp("codex", ["exec"], help).descriptor),
  );
  await writeFile(
    join(directory, "entry.ts"),
    'import {loopy} from "loopy"; import {codexExec} from "./codex.ts"; export default loopy("generated", {input:{}, run:()=>codexExec({args:["hi"], flags:{json:true}})});',
  );
  const result = await compileOrThrow(join(directory, "entry.ts"));

  expect(result.graph.nodes[0]).toMatchObject({
    kind: "command",
    key: "codex.exec",
    argv: ["codex", "hi"],
    flags: { json: true },
  });
});
