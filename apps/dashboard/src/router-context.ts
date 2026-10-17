import type { QueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { LoopyBackend } from "./backend/backend.ts";

export type RouterContext = { backend: LoopyBackend; queryClient: QueryClient };

export function useBackend(): LoopyBackend {
  return useRouteContext({ from: "__root__", select: (context) => context.backend });
}
