import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BackendError } from "./backend/backend";
import { localHttpBackend } from "./backend/local-http";
import { AccessGate } from "./components/shell/access-gate";
import { routeTree } from "./routeTree.gen";
import { checkAccess, closeOnUnauthorized } from "./session/access";
import { bootSession, reloadOnNewAddress } from "./session/boot";
import "./style.css";

reloadOnNewAddress();

const session = bootSession({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? window.location.origin,
  pageUrl: window.location.href,
  storage: () => sessionStorage,
  replaceUrl: (url) => history.replaceState(null, "", url),
});

const backend = localHttpBackend(session);

const checkSession = () => {
  void checkAccess(backend, session.token);
};

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
  context: { backend },
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

checkSession();

createRoot(root).render(
  <StrictMode>
    <AccessGate apiUrl={session.baseUrl} retry={checkSession}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AccessGate>
  </StrictMode>,
);
