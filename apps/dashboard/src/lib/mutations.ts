import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Json, RunView } from "loopy/contract";
import type { LoopyBackend } from "../backend/backend.ts";
import { useBackend } from "../router-context.ts";
import { applyRunView } from "./stream.ts";

/** A mutation that returns a run. The returned run is shown at once; the stream follows. */
export function useRunMutation<Variables = void>(
  action: (backend: LoopyBackend, variables: Variables) => Promise<RunView>,
) {
  const backend = useBackend();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (variables: Variables) => action(backend, variables),
    onSuccess: (run) => applyRunView(client, run),
  });
}

export function useResolveHook(token: string) {
  return useRunMutation((backend, payload: Json) => backend.resolveHook(token, payload));
}
