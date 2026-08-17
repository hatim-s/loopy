import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import type { ApiClient } from "./api";
import { createFeaturePages, type FeatureKey, type FeaturePageRegistry } from "./feature-slots";
import { StudioShell } from "./shell";

export type StudioRouterContext = { api: ApiClient; queryClient: QueryClient };

const rootRoute = createRootRouteWithContext<StudioRouterContext>()({
  component: () => (
    <StudioShell>
      <Outlet />
    </StudioShell>
  ),
});

function slotRoute(path: FeatureKey, pages: ReturnType<typeof createFeaturePages>) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => {
      const Page = pages[path];
      return (
        <div className="route-view">
          <Page feature={path} />
        </div>
      );
    },
  });
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/sessions" });
  },
});

export function createStudioRouter(
  context: StudioRouterContext,
  featurePages: FeaturePageRegistry = {},
) {
  const pages = createFeaturePages(featurePages);
  const routeTree = rootRoute.addChildren([
    indexRoute,
    slotRoute("providers", pages),
    slotRoute("sessions", pages),
    slotRoute("extractions", pages),
    slotRoute("runs", pages),
    slotRoute("workflows", pages),
    slotRoute("settings", pages),
  ]);
  return createRouter({ routeTree, context });
}

export type StudioRouter = ReturnType<typeof createStudioRouter>;
