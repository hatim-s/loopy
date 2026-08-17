import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowNode,
} from "@loopy/contracts";
import { describe, expect, test } from "vitest";
import {
  autoLayout,
  createEditorStore,
  decodeWorkflowDocument,
  diffWorkflowVersions,
  keyboardIntent,
} from "../src/features/editor-core/index.ts";

const fixture = (): WorkflowDefinition =>
  WorkflowDefinitionSchema.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url)),
        "utf8",
      ),
    ),
  );

const agent = (id: string, name = "Agent"): WorkflowNode => ({
  id,
  kind: "agent",
  name,
  prompt: "Do the work.",
  provider: "codex",
  skills: [],
  inputBindings: {},
  requiredCapabilities: [],
  completionContract: "node_completion",
  tags: [],
});

const route = (id: string): WorkflowNode => ({
  id,
  kind: "route",
  name: "Branch",
  predicate: {
    kind: "comparison",
    operator: "equals",
    left: { kind: "literal", value: "yes" },
    right: { kind: "literal", value: "yes" },
  },
  tags: [],
});

const join = (id: string): WorkflowNode => ({
  id,
  kind: "join",
  name: "Join",
  policy: "all",
  outputMode: "array",
  tags: [],
});

describe("editor core", () => {
  test("applies typed node and edge commands atomically with deterministic IDs", () => {
    const document = fixture();
    const store = createEditorStore(document, {
      ids: (kind) =>
        ({
          node: "55555555-5555-4555-8555-555555555555",
          edge: "66666666-6666-4666-8666-666666666666",
          workflow: "77777777-7777-4777-8777-777777777777",
        })[kind],
    });
    const newNode = agent("55555555-5555-4555-8555-555555555555", "Second agent");
    const { id: _ignoredNodeId, ...newNodeWithoutId } = newNode;
    const createdNode = store.getState().createNode(newNodeWithoutId, { x: 10, y: 20 });
    expect(createdNode).toMatchObject({ ok: true });
    expect(store.getState().document.nodes.at(-1)?.id).toBe("55555555-5555-4555-8555-555555555555");
    expect(
      store.getState().apply({
        type: "add_edge",
        edge: {
          id: "66666666-6666-4666-8666-666666666666",
          source: document.nodes[1]?.id as string,
          target: newNode.id,
          metadata: {},
        },
      }),
    ).toMatchObject({ ok: true });
    expect(store.getState().document.nodes.at(-1)?.name).toBe("Second agent");
    expect(store.getState().document.edges.at(-1)?.target).toBe(newNode.id);
    expect(store.getState().dirty).toBe(true);
  });

  test("supports route labels and join policies while rejecting wrong-node edits", () => {
    const document = fixture();
    const store = createEditorStore(document);
    const routeNode = route("55555555-5555-4555-8555-555555555555");
    const joinNode = join("66666666-6666-4666-8666-666666666666");
    expect(store.getState().apply({ type: "add_node", node: routeNode }).ok).toBe(true);
    expect(store.getState().apply({ type: "add_node", node: joinNode }).ok).toBe(true);
    expect(
      store.getState().apply({
        type: "add_edge",
        edge: {
          id: "77777777-7777-4777-8777-777777777777",
          source: routeNode.id,
          target: joinNode.id,
          metadata: {},
        },
      }).ok,
    ).toBe(true);
    expect(
      store.getState().apply({
        type: "set_branch_label",
        edgeId: "77777777-7777-4777-8777-777777777777",
        label: "ready",
      }).ok,
    ).toBe(true);
    expect(
      store.getState().apply({
        type: "set_join_policy",
        nodeId: joinNode.id,
        policy: "quorum",
        quorum: 1,
        outputMode: "object",
      }).ok,
    ).toBe(true);
    expect(store.getState().document.edges.at(-1)?.label).toBe("ready");
    expect(store.getState().document.nodes.at(-1)).toMatchObject({
      policy: "quorum",
      quorum: 1,
      outputMode: "object",
    });
    const before = JSON.stringify(store.getState().document);
    const result = store
      .getState()
      .apply({ type: "set_branch_label", edgeId: document.edges[0]?.id as string, label: "wrong" });
    expect(result).toMatchObject({ ok: false, reason: "invalid_command" });
    expect(JSON.stringify(store.getState().document)).toBe(before);
  });

  test("verify command edits and invalid operations roll back without history entries", () => {
    const store = createEditorStore(fixture(), { historyLimit: 2 });
    const verifyId = store.getState().document.nodes.find((node) => node.kind === "verify")
      ?.id as string;
    expect(
      store.getState().apply({
        type: "add_verify_command",
        nodeId: verifyId,
        command: { command: "bun", args: ["run", "check"], timeoutMs: 120000 },
      }).ok,
    ).toBe(true);
    const before = JSON.stringify(store.getState().document);
    const history = store.getState().history.past.length;
    expect(
      store.getState().apply({ type: "remove_verify_command", nodeId: verifyId, index: 99 }),
    ).toMatchObject({ ok: false });
    expect(JSON.stringify(store.getState().document)).toBe(before);
    expect(store.getState().history.past.length).toBe(history);
    expect(
      store.getState().apply({
        type: "add_edge",
        edge: {
          id: "88888888-8888-4888-8888-888888888888",
          source: "not-a-node",
          target: verifyId,
          metadata: {},
        },
      }),
    ).toMatchObject({ ok: false, reason: "missing_node" });
  });

  test("undo/redo is bounded and a new edit invalidates redo", () => {
    const store = createEditorStore(fixture(), { historyLimit: 2 });
    const first = store.getState().document.nodes[0]?.id as string;
    expect(
      store.getState().apply({ type: "update_node", nodeId: first, patch: { name: "One" } }).ok,
    ).toBe(true);
    expect(
      store.getState().apply({ type: "update_node", nodeId: first, patch: { name: "Two" } }).ok,
    ).toBe(true);
    expect(
      store.getState().apply({ type: "update_node", nodeId: first, patch: { name: "Three" } }).ok,
    ).toBe(true);
    expect(store.getState().history.past).toHaveLength(2);
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().document.nodes[0]?.name).toBe("Two");
    expect(store.getState().redo()).toBe(true);
    expect(store.getState().document.nodes[0]?.name).toBe("Three");
    expect(store.getState().undo()).toBe(true);
    expect(
      store.getState().apply({ type: "update_node", nodeId: first, patch: { name: "Branch edit" } })
        .ok,
    ).toBe(true);
    expect(store.getState().redo()).toBe(false);
  });

  test("server validation applies to the current revision without changing the draft", () => {
    const store = createEditorStore(fixture());
    const nodeId = store.getState().document.nodes[0]?.id as string;
    store.getState().apply({ type: "update_node", nodeId, patch: { name: "Draft" } });
    const draft = JSON.stringify(store.getState().document);
    store.getState().applyValidation({
      valid: false,
      diagnostics: [{ code: "NODE_UNREACHABLE", message: "Review this node." }],
    });
    expect(JSON.stringify(store.getState().document)).toBe(draft);
    expect(store.getState().validation).toMatchObject({
      status: "invalid",
      source: "server",
      checkedRevision: 1,
    });
  });

  test("import/export is contract-validated and auto-layout only changes positions", () => {
    const document = fixture();
    const store = createEditorStore(document);
    const beforeRevision = store.getState().revision;
    const beforeDirty = store.getState().dirty;
    const positions = store.getState().autoLayout();
    expect(positions).toEqual(autoLayout(document));
    expect(store.getState().revision).toBe(beforeRevision);
    expect(store.getState().dirty).toBe(beforeDirty);
    expect(decodeWorkflowDocument(store.getState().exportDocument())).toMatchObject({ ok: true });
    const draft = JSON.stringify(store.getState().document);
    expect(store.getState().importDocument("not-json")).toMatchObject({ ok: false });
    expect(JSON.stringify(store.getState().document)).toBe(draft);
  });

  test("builds deterministic version diffs and keyboard intents", () => {
    const before = fixture();
    const after = structuredClone(before);
    const first = after.nodes[0];
    if (!first) throw new Error("fixture must have a first node");
    after.nodes[0] = { ...first, name: "Renamed" };
    after.nodes.push(agent("55555555-5555-4555-8555-555555555555"));
    expect(diffWorkflowVersions(before, after)).toMatchObject({
      addedNodes: [{ id: "55555555-5555-4555-8555-555555555555" }],
      changedNodes: [{ before: { name: "Implement" }, after: { name: "Renamed" } }],
    });
    expect(keyboardIntent({ key: "z", metaKey: true })).toBe("undo");
    expect(keyboardIntent({ key: "z", ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(keyboardIntent({ key: "l" })).toBe("auto_layout");
  });
});
