import { useRouteContext } from "@tanstack/react-router";
import type { LoopyBackend } from "./backend/backend";

export type RouterContext = { backend: LoopyBackend };

export function useBackend(): LoopyBackend {
  return useRouteContext({ from: "__root__", select: (context) => context.backend });
}
