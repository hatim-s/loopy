import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BackendError, type LoopyBackend } from "./backend/backend.ts";
import { backendConfigSchema } from "./backend/config.ts";
import { localHttpBackend } from "./backend/local-http.ts";
import { AccessGate } from "./components/shell/access-gate.tsx";
import {
  addressToken,
  browserConnection,
  checkAccess,
  closeOnUnauthorized,
} from "./lib/connection.ts";
import { routeTree } from "./routeTree.gen.ts";
import "./style.css";

type Session = {
  backend: LoopyBackend;
  /** Absent for the fake backend, which has no token to check. */
  gate?: { apiUrl: string; check: () => void };
};

async function createSession(): Promise<Session> {
  const connection = browserConnection({
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? window.location.origin,
    pageUrl: window.location.href,
    storage: () => sessionStorage,
    replaceUrl: (url) => history.replaceState(null, "", url),
  });

  const mode = import.meta.env.VITE_BACKEND ?? "http";

  const config = backendConfigSchema.parse(
    mode === "http" ? { mode, baseUrl: import.meta.env.VITE_API_BASE_URL } : { mode },
  );

  if (config.mode === "fake") {
    const [{ fakeBackend }, { demoScript }] = await Promise.all([
      import("./backend/fake.ts"),
      import("./backend/demo.ts"),
    ]);

    return { backend: fakeBackend(demoScript()) };
  }

  const backend = localHttpBackend(connection);

  return {
    backend,
    gate: {
      apiUrl: connection.baseUrl,
      check: () => {
        void checkAccess(backend, connection.token);
      },
    },
  };
}

// Pasting a fresh `loopy ui` address over this page only changes the fragment, which does not
// reload, so reload here and let boot pick up the new token.
window.addEventListener("hashchange", () => {
  if (addressToken(new URL(window.location.href)) !== null) {
    window.location.reload();
  }
});

const session = await createSession();

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: closeOnUnauthorized }),
  mutationCache: new MutationCache({ onError: closeOnUnauthorized }),
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
  context: { backend: session.backend, queryClient },
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

const app = (
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);

session.gate?.check();

createRoot(root).render(
  <StrictMode>
    {session.gate ? (
      <AccessGate apiUrl={session.gate.apiUrl} retry={session.gate.check}>
        {app}
      </AccessGate>
    ) : (
      app
    )}
  </StrictMode>,
);
