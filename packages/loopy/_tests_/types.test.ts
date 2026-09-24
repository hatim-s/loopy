import { expect, test } from "bun:test";
import { defineCommand } from "../src/command";
import { eq, node, trigger } from "../src/workflow";

const codexExec = defineCommand({
  program: "codex",
  path: ["exec"],
  positionals: [{ name: "prompt", optional: true }],
  flags: {
    model: { cli: "--model", kind: "string" },
    json: { cli: "--json", kind: "boolean" },
    sandbox: { cli: "--sandbox", kind: "string", choices: ["read-only", "workspace-write"] },
  },
});
const noArgs = defineCommand({ program: "git", path: ["status"], positionals: [] });

test("generated command signatures accept workflow references", () => {
  expect(codexExec().args).toEqual(["exec"]);
  expect(noArgs().args).toEqual(["status"]);
  const workflow = trigger<{ prompt: string }>("typed")
    .node("first", ({ input }) => codexExec({ args: [input.prompt], flags: { json: true } }))
    .condition(
      "ok",
      ({ steps }) => eq(steps.first.exitCode, 0),
      node("yes", codexExec({ args: ["yes"] })),
      node("no", codexExec({ args: ["no"] })),
    );
  expect(workflow.build().nodes).toHaveLength(2);
});

function compileOnlyChecks() {
  // @ts-expect-error Unknown flags do not compile.
  codexExec({ args: [], flags: { typo: true } });
  // @ts-expect-error The CLI help declared at most one positional argument.
  codexExec({ args: ["one", "two"] });
  // @ts-expect-error Flags retain their value type.
  codexExec({ args: [], flags: { json: "true" } });
  // @ts-expect-error A descriptor without flags does not accept arbitrary flags.
  noArgs({ flags: { typo: true } });
  // @ts-expect-error An explicitly empty flag descriptor rejects unknown flags too.
  defineCommand({ program: "git", flags: {} })({ flags: { typo: true } });
}
void compileOnlyChecks;
