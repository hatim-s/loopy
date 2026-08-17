// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/app/api";
import { createStudioRouter } from "../src/app/router";

const domIt = typeof document === "undefined" ? it.skip : it;

describe("studio router", () => {
  domIt("routes to the sessions feature slot and keeps navigation deterministic", async () => {
    const router = createStudioRouter({
      api: createApiClient({ fetcher: fetch }),
      queryClient: new QueryClient(),
    });
    router.history = createMemoryHistory({ initialEntries: ["/sessions"] });
    render(<RouterProvider router={router} />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Agent sessions" })).toBeTruthy(),
    );
    expect(screen.getByText("Waiting for feature data")).toBeTruthy();
  });
});
