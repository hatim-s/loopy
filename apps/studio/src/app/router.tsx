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

function slotRoute(
  path: FeatureKey,
  pages: ReturnType<typeof createFeaturePages>,
  context: StudioRouterContext,
) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => {
      const Page = pages[path];
      return (
        <div className="route-view">
          <Page feature={path} api={context.api} />
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
    slotRoute("providers", pages, context),
    slotRoute("sessions", pages, context),
    slotRoute("extractions", pages, context),
    slotRoute("runs", pages, context),
    slotRoute("workflows", pages, context),
    slotRoute("settings", pages, context),
  ]);
  return createRouter({ routeTree, context });
}

export type StudioRouter = ReturnType<typeof createStudioRouter>;
