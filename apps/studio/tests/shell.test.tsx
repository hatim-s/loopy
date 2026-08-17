// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/app/api";
import { createStudioRouter } from "../src/app/router";

function renderShell() {
  const router = createStudioRouter({ api: createApiClient(), queryClient: new QueryClient() });
  router.history = createMemoryHistory({ initialEntries: ["/sessions"] });
  return render(<RouterProvider router={router} />);
}

describe("StudioShell", () => {
  it("renders the debugger frame with keyboard-accessible navigation", async () => {
    renderShell();
    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: "Studio navigation" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Sessions" }).getAttribute("href")).toBe("/sessions");
      expect(screen.getByText("Runtime idle")).toBeTruthy();
      expect(screen.getByText("Agent sessions")).toBeTruthy();
    });
  });

  it("exposes an explicit collapse control", async () => {
    renderShell();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy(),
    );
  });
});
