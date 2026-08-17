// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../src/app/api";
import { createStudioRouter } from "../src/app/router";

const domIt = typeof document === "undefined" ? it.skip : it;

function renderShell() {
  const router = createStudioRouter({ api: createApiClient(), queryClient: new QueryClient() });
  router.history = createMemoryHistory({ initialEntries: ["/sessions"] });
  return render(<RouterProvider router={router} />);
}

describe("StudioShell", () => {
  afterEach(() => cleanup());

  domIt("renders the debugger frame with keyboard-accessible navigation", async () => {
    renderShell();
    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: "Studio navigation" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Sessions" }).getAttribute("href")).toBe("/sessions");
      expect(screen.getByText("Runtime idle")).toBeTruthy();
      expect(screen.getByText("Agent sessions")).toBeTruthy();
    });
  });

  domIt("exposes an explicit collapse control", async () => {
    renderShell();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy(),
    );
  });

  domIt("keeps compact icon-only navigation links named and keyboard-focusable", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    renderShell();

    await waitFor(() => {
      for (const label of [
        "Sessions",
        "Runs",
        "Extractions",
        "Workflows",
        "Providers",
        "Settings",
      ]) {
        const link = screen.getByRole("link", { name: label });
        expect(link.getAttribute("aria-label")).toBe(label);
        expect(link.tabIndex).toBeGreaterThanOrEqual(0);
        link.focus();
        expect(document.activeElement).toBe(link);
      }
    });
  });
});
