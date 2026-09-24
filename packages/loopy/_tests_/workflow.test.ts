import { describe, expect, test } from "bun:test";
import { command } from "../src/command";
import { at, compileWorkflow, eq, node, trigger, validateWorkflow } from "../src/workflow";

describe("TypeScript workflow authoring", () => {
  test("accepts a builder from another package installation", () => {
    const graph = trigger("separate-install").node("hello", command("echo", "hello")).build();
    expect(compileWorkflow({ build: () => graph })).toEqual(graph);
  });
  test("compiles typed references and branches into serializable data", () => {
    const workflow = trigger<{ prompt: string; settings: { label: string } }>("review")
      .node("agent", ({ input }) => command("codex", "exec", input.prompt))
      .condition(
        "passed",
        ({ steps }) => eq(steps.agent.exitCode, 0),
        ({ input }) => node("yes", command("git", "status", input.prompt)),
        node("no", command("git", "diff")),
      )
      .node("finish", ({ input, steps }) =>
        command("printf", at(input.settings, "label"), steps.passed.branch),
      );

    const compiled = compileWorkflow(workflow);
    expect(compiled.nodes[0]).toEqual({
      id: "agent",
      kind: "command",
      command: {
        program: "codex",
        args: ["exec", { $ref: { source: "input", path: ["prompt"] } }],
      },
    });
    expect(compiled.nodes[1]).toMatchObject({
      kind: "condition",
      test: {
        $op: "eq",
        args: [{ $ref: { source: "steps", path: ["agent", "exitCode"] } }, 0],
      },
    });
    expect(JSON.parse(JSON.stringify(compiled))).toEqual(compiled);
    expect((compiled.nodes[2] as { command: { args: unknown[] } }).command.args[0]).toEqual({
      $ref: { source: "input", path: ["settings", "label"] },
    });
    expect(
      (compiled.nodes[1] as { then: Array<{ command: { args: unknown[] } }> }).then[0]?.command
        .args[1],
    ).toEqual({
      $ref: { source: "input", path: ["prompt"] },
    });
  });

  test("chaining keeps the earlier workflow unchanged", () => {
    const start = trigger("stable").node("first", command("git", "status"));
    const extended = start.node("second", command("git", "diff"));
    expect(start.build().nodes).toHaveLength(1);
    expect(extended.build().nodes).toHaveLength(2);
  });

  test("addresses array input by index", () => {
    const graph = trigger<{ files: string[] }>("array-ref")
      .node("show", ({ input }) => command("echo", at(input.files, 0)))
      .build();
    expect((graph.nodes[0] as { command: { args: unknown[] } }).command.args[0]).toEqual({
      $ref: { source: "input", path: ["files", "0"] },
    });
    expect(() => at({ $ref: { source: "input", path: ["files"] } }, -1)).toThrow(
      "nonnegative integer",
    );
  });

  test("rejects duplicate ids across branches and invalid persisted values", () => {
    const duplicate = trigger("duplicate")
      .node("same", command("git", "status"))
      .condition(
        "route",
        true,
        node("same", command("git", "diff")),
        node("other", command("git", "log")),
      );
    expect(() => duplicate.build()).toThrow("Duplicate workflow node id 'same'");
    expect(() =>
      validateWorkflow({
        version: 1,
        slug: "bad",
        nodes: [{ id: "x", kind: "command", command: { program: "git", args: [() => 1] } }],
      }),
    ).toThrow("literal, reference, or expression");
  });

  test("rejects references to future or branch-local steps", () => {
    const future = {
      version: 1,
      slug: "future",
      nodes: [
        node("first", command("echo", { $ref: { source: "steps", path: ["later", "stdout"] } })),
        node("later", command("echo", "done")),
      ],
    };
    expect(() => validateWorkflow(future)).toThrow("not available yet");
    const branch = trigger("branch")
      .condition(
        "route",
        true,
        node("yes", command("echo", "yes")),
        node("no", command("echo", "no")),
      )
      .node("after", command("echo", { $ref: { source: "steps", path: ["yes", "stdout"] } }));
    expect(() => branch.build()).toThrow("not available yet");
  });

  test("rejects hidden fields that JSON serialization would discard", () => {
    const invalid = {
      version: 1,
      slug: "strict",
      nodes: [
        { id: "run", kind: "command", command: { program: "echo", args: ["ok"], hidden: () => 1 } },
      ],
    };
    expect(() => validateWorkflow(invalid)).toThrow("unsupported field 'hidden'");
    const badConstraint = {
      version: 1,
      slug: "bad-constraint",
      nodes: [
        {
          id: "run",
          kind: "command",
          command: {
            program: "tool",
            args: [{ $op: "concat", args: ["--port=", 9229] }],
            argConstraints: { 0: { kind: "number", prefix: "--inspect=" } },
          },
        },
      ],
    };
    expect(() => validateWorkflow(badConstraint)).toThrow("has no matching value");
  });
});
