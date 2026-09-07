// @vitest-environment jsdom

import { WorkflowPatchSchema } from "@loopy/contracts";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { applyWorkflowPatch } from "../../../packages/local-api/src/workflow-edit";
import { createApiClient } from "../src/app/api";
import { createStudioRouter } from "../src/app/router";
import { createWorkflowEditorAdapter, fallbackWorkflow } from "../src/features/editor";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const response = (body: unknown) => Response.json(body);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(cleanup);

test("clearing a condition emits operations which remove it through the patch handler", async () => {
  const initial = fallbackWorkflow(a);
  const edge = initial.edges[0];
  if (!edge) throw new Error("edge missing");
  edge.condition = {
    kind: "comparison",
    operator: "equals",
    left: { kind: "literal", value: true },
    right: { kind: "literal", value: true },
  };
  let persisted = initial;
  const api = createApiClient({
    baseUrl: "/api/v1",
    fetcher: async (input, init) => {
      if (String(input).endsWith("/patch")) {
        const patch = WorkflowPatchSchema.parse({
          schemaVersion: "1",
          workflowId: a,
          ...JSON.parse(String(init?.body)),
        });
        expect(("operations" in patch ? patch.operations : patch.patch).map((op) => op.op)).toEqual(
          ["remove_edge", "add_edge"],
        );
        persisted = applyWorkflowPatch(persisted, patch);
        return response({ workflowId: a, version: 2, definition: persisted });
      }
      return response({ workflowId: a, version: 1, definition: persisted });
    },
  });
  const adapter = createWorkflowEditorAdapter(api);
  const changed = structuredClone(initial);
  delete changed.edges[0]?.condition;
  await adapter.save({ workflowId: a, baseVersion: 1, definition: changed, summary: "clear" });
  expect((await adapter.load(a, 2)).definition.edges[0]?.condition).toBeUndefined();
});

test("keyboard saves are single-flight and stale route completions cannot replace the new document", async () => {
  const records = new Map(
    [a, b].map((id) => [
      id,
      {
        workflowId: id,
        version: 1,
        definition: { ...fallbackWorkflow(id), name: id === a ? "Workflow A" : "Workflow B" },
      },
    ]),
  );
  let resolveSave: ((value: Response) => void) | undefined;
  const saves: string[] = [];
  const api = createApiClient({
    baseUrl: "/api/v1",
    fetcher: async (input) => {
      const url = String(input);
      const id = url.includes(a) ? a : b;
      const record = records.get(id);
      if (!record) throw new Error("Missing workflow fixture");
      if (url.endsWith("/patch")) {
        saves.push(id);
        if (id === a)
          return new Promise<Response>((r) => {
            resolveSave = r;
          });
        return response({ ...record, version: 2 });
      }
      if (url.includes("/workflows/")) return response(record);
      return response({ projects: [], providers: [], tools: [] });
    },
  });
  const router = createStudioRouter({ api, queryClient: new QueryClient() });
  router.history = createMemoryHistory({ initialEntries: [`/workflows/${a}/edit`] });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(screen.getByLabelText("Workflow name")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "A edited" } });
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await waitFor(() => expect(saves).toEqual([a]));
  await act(async () => {
    await router.navigate({ to: "/workflows/$workflowId/edit", params: { workflowId: b } });
  });
  await waitFor(() =>
    expect((screen.getByLabelText("Workflow name") as HTMLInputElement).value).toBe("Workflow B"),
  );
  await act(async () => resolveSave?.(response({ ...records.get(a), version: 2 })));
  expect((screen.getByLabelText("Workflow name") as HTMLInputElement).value).toBe("Workflow B");
  fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "B edited" } });
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await waitFor(() => expect(saves).toEqual([a, b]));
});
