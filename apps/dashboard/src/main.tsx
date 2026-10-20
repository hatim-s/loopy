import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BackendError, type LoopyBackend } from "./backend/backend.ts";
import { backendConfigSchema } from "./backend/config.ts";
import { localHttpBackend } from "./backend/local-http.ts";
import { routeTree } from "./routeTree.gen.ts";
import "./style.css";

const TOKEN_KEY = "loopy-token";

/** `loopy ui` opens the page with #token=…; keep it for the tab and drop it from the URL. */
function captureToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");

  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    const url = new URL(window.location.href);
    url.hash = "";
    history.replaceState(null, "", url);
  }

  return sessionStorage.getItem(TOKEN_KEY);
}

async function createBackend(): Promise<LoopyBackend> {
  const config = backendConfigSchema.parse({ mode: import.meta.env.VITE_BACKEND ?? "http" });

  if (config.mode === "fake") {
    const [{ fakeBackend }, { demoScript }] = await Promise.all([
      import("./backend/fake.ts"),
      import("./backend/demo.ts"),
    ]);

    return fakeBackend(demoScript());
  }

  const connection = { origin: window.location.origin, token: captureToken() };

  return localHttpBackend(connection);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, error) =>
        count < 3 && error instanceof BackendError && error.code === "unreachable",
    },
  },
});

const router = createRouter({
  routeTree,
  context: { backend: await createBackend(), queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("The dashboard root element is missing from index.html.");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
