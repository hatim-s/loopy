// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createApiClient } from "../src/app/api";
import { RunsPage } from "../src/app/pages";

vi.mock("../src/features", async (original) => ({
  ...(await original<typeof import("../src/features")>()),
  DebuggerGraph: () => null,
}));
afterEach(cleanup);

for (const outcome of ["empty", "error"] as const) {
  test(`Newer runs remains available when an older page is ${outcome}`, async () => {
    window.history.replaceState(null, "", "/runs");
    const requests: string[] = [];
    const api = createApiClient({
      baseUrl: "/api/v1",
      fetcher: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("cursor="))
          return outcome === "error"
            ? Response.json({ error: { message: "History unavailable" } }, { status: 500 })
            : Response.json({ runs: [] });
        if (url.includes("/runs?"))
          return Response.json({
            runs: [{ id: "newest", status: "succeeded" }],
            nextCursor: "older",
          });
        return Response.json({
          run: { id: "newest", status: "succeeded" },
          events: [],
          attempts: [],
          artifacts: [],
        });
      },
    });
    api.streamEvents = () => () => {};
    render(<RunsPage feature="runs" api={api} />);
    const older = screen.getByRole("button", { name: "Older runs" });
    await waitFor(() => expect((older as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(older);
    if (outcome === "empty") await screen.findByText("No graph runs");
    else await screen.findByText(/History unavailable/);
    const newer = screen.getByRole("button", { name: "Newer runs" });
    expect((newer as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(newer);
    await waitFor(() =>
      expect(requests.filter((url) => url.endsWith("/runs?limit=50"))).toHaveLength(2),
    );
  });
}
