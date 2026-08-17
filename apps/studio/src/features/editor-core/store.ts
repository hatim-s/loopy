import type { WorkflowDefinition, WorkflowNode } from "@loopy/contracts";
import { immer } from "zustand/middleware/immer";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";
import { applyEditorCommand, createEdge, createNode } from "./commands.ts";
import { autoLayout } from "./layout.ts";
import type {
  CommandResult,
  EditorCommand,
  EditorHistoryEntry,
  EditorIdFactory,
  EditorPosition,
  EditorSelection,
  EditorStateSnapshot,
  EditorValidation,
  ServerValidationResult,
} from "./types.ts";
import {
  decodeWorkflowDocument,
  encodeWorkflowDocument,
  validationFromServer,
} from "./validation.ts";

export type EditorStore = {
  document: WorkflowDefinition;
  positions: Record<string, EditorPosition>;
  selection: EditorSelection;
  dirty: boolean;
  revision: number;
  validation: EditorValidation;
  history: { past: EditorHistoryEntry[]; future: EditorHistoryEntry[]; limit: number };
  apply: (command: EditorCommand) => CommandResult;
  createNode: (
    node: import("./types.ts").NewEditorNode,
    position?: EditorPosition,
  ) => CommandResult;
  createEdge: (edge: import("./types.ts").NewEditorEdge) => CommandResult;
  undo: () => boolean;
  redo: () => boolean;
  selectNodes: (nodeIds: readonly string[]) => void;
  selectEdges: (edgeIds: readonly string[]) => void;
  clearSelection: () => void;
  setPosition: (nodeId: string, position: EditorPosition) => void;
  autoLayout: () => Record<string, EditorPosition>;
  /** Apply a response only when it was produced for the current draft revision. */
  applyValidation: (result: ServerValidationResult, checkedRevision?: number) => boolean;
  markSaved: () => void;
  reset: (document: WorkflowDefinition, positions?: Record<string, EditorPosition>) => void;
  /** Reset a saved draft only if no edits occurred after the submitted revision. */
  resetIfRevision: (
    document: WorkflowDefinition,
    submittedRevision: number,
    positions?: Record<string, EditorPosition>,
  ) => boolean;
  importDocument: (
    input: unknown,
  ) => { ok: true } | { ok: false; diagnostics: EditorValidation["diagnostics"] };
  exportDocument: (pretty?: boolean) => string;
  snapshot: () => EditorStateSnapshot;
};

export type CreateEditorStoreOptions = {
  historyLimit?: number;
  ids?: EditorIdFactory;
  positions?: Record<string, EditorPosition>;
};

function defaultIds(kind: "node" | "edge" | "workflow"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  throw new Error(`No UUID generator available for ${kind}. Inject ids in non-browser runtimes.`);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validSelection(document: WorkflowDefinition, selection: EditorSelection): EditorSelection {
  const nodeSet = new Set(document.nodes.map((node) => node.id));
  const edgeSet = new Set(document.edges.map((edge) => edge.id));
  return {
    nodeIds: [...new Set(selection.nodeIds)].filter((id) => nodeSet.has(id)),
    edgeIds: [...new Set(selection.edgeIds)].filter((id) => edgeSet.has(id)),
  };
}

export function createEditorStore(
  initialDocument: WorkflowDefinition,
  options: CreateEditorStoreOptions = {},
): StoreApi<EditorStore> {
  const historyLimit = Math.max(1, options.historyLimit ?? 100);
  const initialPositions = options.positions ?? autoLayout(initialDocument);
  const ids = options.ids ?? defaultIds;
  const initializer = immer<EditorStore>(
    (set, get): EditorStore => ({
      document: structuredClone(initialDocument),
      positions: structuredClone(initialPositions),
      selection: { nodeIds: [], edgeIds: [] },
      dirty: false,
      revision: 0,
      validation: { status: "idle", diagnostics: [] },
      history: { past: [], future: [], limit: historyLimit },
      apply(command) {
        const current = get();
        const outcome = applyEditorCommand(current.document, command, ids);
        if (!("document" in outcome)) return outcome;
        if (!outcome.result.changed || sameJson(outcome.document, current.document))
          return outcome.result;
        const previousDocument = structuredClone(current.document);
        const previousPositions = structuredClone(current.positions);
        set((state) => {
          state.history.past.push({
            document: previousDocument,
            positions: previousPositions,
          } as never);
          if (state.history.past.length > state.history.limit) state.history.past.shift();
          state.history.future = [];
          state.document = outcome.document as never;
          state.selection = validSelection(outcome.document, current.selection) as never;
          state.dirty = true;
          state.revision += 1;
          state.validation = { status: "idle", diagnostics: [] };
          if (command.type === "add_node" && command.position)
            state.positions[command.node.id] = command.position;
          if (command.type === "remove_node") delete state.positions[command.nodeId];
        });
        return outcome.result;
      },
      createNode(node, position) {
        const created = createNode(node, ids);
        return get().apply({
          type: "add_node",
          node: created as WorkflowNode,
          ...(position ? { position } : {}),
        });
      },
      createEdge(edge) {
        return get().apply({ type: "add_edge", edge: createEdge(edge, ids) });
      },
      undo() {
        const current = get();
        const entry = current.history.past.at(-1);
        if (!entry) return false;
        const currentDocument = structuredClone(current.document);
        const currentPositions = structuredClone(current.positions);
        set((state) => {
          state.history.past.pop();
          state.history.future.push({
            document: currentDocument,
            positions: currentPositions,
          } as never);
          state.document = structuredClone(entry.document) as never;
          state.positions = structuredClone(entry.positions);
          state.selection = validSelection(entry.document, current.selection) as never;
          state.dirty = true;
          state.revision += 1;
          state.validation = { status: "idle", diagnostics: [] };
        });
        return true;
      },
      redo() {
        const current = get();
        const entry = current.history.future.at(-1);
        if (!entry) return false;
        const currentDocument = structuredClone(current.document);
        const currentPositions = structuredClone(current.positions);
        set((state) => {
          state.history.future.pop();
          state.history.past.push({
            document: currentDocument,
            positions: currentPositions,
          } as never);
          if (state.history.past.length > state.history.limit) state.history.past.shift();
          state.document = structuredClone(entry.document) as never;
          state.positions = structuredClone(entry.positions);
          state.selection = validSelection(entry.document, current.selection) as never;
          state.dirty = true;
          state.revision += 1;
          state.validation = { status: "idle", diagnostics: [] };
        });
        return true;
      },
      selectNodes(nodeIds) {
        const document = get().document;
        const selection = validSelection(document, { nodeIds: [...nodeIds], edgeIds: [] });
        set((state) => {
          state.selection = selection as never;
        });
      },
      selectEdges(edgeIds) {
        const document = get().document;
        const selection = validSelection(document, { nodeIds: [], edgeIds: [...edgeIds] });
        set((state) => {
          state.selection = selection as never;
        });
      },
      clearSelection() {
        set((state) => {
          state.selection = { nodeIds: [], edgeIds: [] };
        });
      },
      setPosition(nodeId, position) {
        if (!get().document.nodes.some((node) => node.id === nodeId)) return;
        set((state) => {
          state.positions[nodeId] = { x: position.x, y: position.y };
        });
      },
      autoLayout() {
        const positions = autoLayout(get().document);
        set((state) => {
          state.positions = positions;
        });
        return positions;
      },
      applyValidation(result, checkedRevision = get().revision) {
        const normalized = validationFromServer(result);
        if (checkedRevision !== get().revision) return false;
        set((state) => {
          state.validation = { ...normalized, checkedRevision, source: "server" };
        });
        return true;
      },
      markSaved() {
        set((state) => {
          state.dirty = false;
        });
      },
      reset(document, positions = autoLayout(document)) {
        set((state) => {
          state.document = structuredClone(document) as never;
          state.positions = structuredClone(positions);
          state.selection = { nodeIds: [], edgeIds: [] };
          state.dirty = false;
          state.revision = 0;
          state.validation = { status: "idle", diagnostics: [] };
          state.history = { past: [], future: [], limit: historyLimit };
        });
      },
      resetIfRevision(document, submittedRevision, positions = autoLayout(document)) {
        if (get().revision !== submittedRevision) return false;
        get().reset(document, positions);
        return true;
      },
      importDocument(input) {
        const decoded = decodeWorkflowDocument(input);
        if (!decoded.ok) return decoded;
        const current = get();
        const previousDocument = structuredClone(current.document);
        const previousPositions = structuredClone(current.positions);
        set((state) => {
          state.history.past.push({
            document: previousDocument,
            positions: previousPositions,
          } as never);
          if (state.history.past.length > state.history.limit) state.history.past.shift();
          state.history.future = [];
          state.document = structuredClone(decoded.document) as never;
          state.positions = autoLayout(decoded.document);
          state.selection = { nodeIds: [], edgeIds: [] };
          state.dirty = true;
          state.revision += 1;
          state.validation = { status: "idle", diagnostics: [] };
        });
        return { ok: true };
      },
      exportDocument(pretty = true) {
        return encodeWorkflowDocument(get().document, pretty);
      },
      snapshot() {
        const state = get();
        return {
          document: structuredClone(state.document),
          positions: structuredClone(state.positions),
          selection: structuredClone(state.selection),
          dirty: state.dirty,
          revision: state.revision,
          validation: structuredClone(state.validation),
        };
      },
    }),
  );
  // Immer's Draft expansion over WorkflowDefinition is recursive enough to
  // exceed TypeScript's instantiation depth. The runtime value is still the
  // typed Immer initializer; this narrow cast keeps the public store typed.
  return createStore<EditorStore>()(initializer as unknown as StateCreator<EditorStore>);
}

export type { EditorIdFactory };
