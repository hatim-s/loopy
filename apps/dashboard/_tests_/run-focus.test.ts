import { expect, test } from "bun:test";
import { graphView } from "@loopy/contract";
import { code, loopy, map } from "@loopy/sdk/graph";
import { graphModel } from "../src/lib/graph";
import { focusOf, openItemTarget, scopeOf } from "../src/lib/run-focus";

const text = { kind: "value", type: "string" } as const;

const NESTED = graphView(
  loopy("nested", {
    input: { groups: "string[]" },
    run: ({ input }) => {
      code("start", { in: {}, out: text, module: "./start.ts" });

      return map(
        input.get("groups"),
        (group) => {
          const entries = code("expand", {
            in: { group },
            out: { kind: "value", type: "string[]" },
            module: "./expand.ts",
          });

          return map(
            entries,
            (entry) => code("work", { in: { entry }, out: text, module: "./work.ts" }),
            { concurrency: 2, onError: "fail" },
          );
        },
        { concurrency: 1, onError: "fail" },
      );
    },
  }),
);

const definition = graphModel(NESTED, null);

function id(label: string) {
  const node = definition.nodes.find((entry) => entry.node.label === label);

  if (!node) {
    throw new Error(`The fixture has no node labelled ${label}.`);
  }

  return node.id;
}

const [outer, inner] = definition.nodes.find((node) => node.id === id("work"))?.maps ?? [];

if (outer === undefined || inner === undefined) {
  throw new Error("The work node must sit inside two maps.");
}

test("a node executes at the top level, in the open item of its map, or nowhere shown", () => {
  expect(scopeOf(definition, null, id("start"))).toEqual([]);
  expect(scopeOf(definition, null, id("work"))).toBeNull();

  const outerItem = [{ nodeId: outer, index: 0 }];
  expect(scopeOf(definition, outerItem, id("expand"))).toEqual(outerItem);
  expect(scopeOf(definition, outerItem, inner)).toEqual(outerItem);
  expect(scopeOf(definition, outerItem, id("work"))).toBeNull();

  const innerItem = [...outerItem, { nodeId: inner, index: 2 }];
  expect(scopeOf(definition, innerItem, id("work"))).toEqual(innerItem);
  expect(scopeOf(definition, innerItem, id("expand"))).toEqual(outerItem);
});

test("the focus is the selected map or the innermost map around the selection", () => {
  expect(focusOf(definition, null, id("start"))).toBeNull();
  expect(focusOf(definition, null, outer)).toEqual({
    mapId: outer,
    parentScope: [],
    inside: false,
  });
  expect(focusOf(definition, null, id("work"))).toEqual({
    mapId: inner,
    parentScope: null,
    inside: true,
  });
  expect(focusOf(definition, [{ nodeId: outer, index: 1 }], id("work"))).toEqual({
    mapId: inner,
    parentScope: [{ nodeId: outer, index: 1 }],
    inside: true,
  });
});

test("opening an item from a map moves to its first node; from inside, the node stays", () => {
  const fromMap = focusOf(definition, null, outer);
  const fromInside = focusOf(definition, [{ nodeId: outer, index: 1 }], id("work"));
  const unreachable = focusOf(definition, null, id("work"));

  if (!fromMap || !fromInside || !unreachable) {
    throw new Error("Each selection must sit in a map.");
  }

  expect(openItemTarget(fromMap, NESTED, 3)).toEqual({
    item: [{ nodeId: outer, index: 3 }],
    node: id("expand"),
  });
  expect(openItemTarget(fromInside, NESTED, 4)).toEqual({
    item: [
      { nodeId: outer, index: 1 },
      { nodeId: inner, index: 4 },
    ],
  });
  expect(openItemTarget(unreachable, NESTED, 0)).toBeNull();
});
