import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Json, PutScheduleBody, RunView, ScheduleView } from "loopy/contract";
import type { LoopyBackend } from "../backend/backend.ts";
import { useBackend } from "../router-context.ts";
import { keys } from "./keys.ts";
import { applyRunView, applyScheduleView, removeScheduleView } from "./stream.ts";

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

export function useSaveSchedule(slug: string) {
  const backend = useBackend();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: PutScheduleBody) => backend.putSchedule(slug, body),
    onSuccess: (schedule) => applyScheduleView(client, schedule),
  });
}

/** Flips the row at once; an error puts the old list back, and the stream confirms success. */
export function useToggleSchedule(slug: string) {
  const backend = useBackend();
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (enabled: boolean) => {
      await client.cancelQueries({ queryKey: keys.schedules });
      const previous = client.getQueryData<ScheduleView[]>(keys.schedules);
      client.setQueryData<ScheduleView[]>(keys.schedules, (current) =>
        current?.map((item) => (item.slug === slug ? { ...item, enabled } : item)),
      );

      try {
        return await backend.setScheduleEnabled(slug, enabled);
      } catch (error) {
        client.setQueryData(keys.schedules, previous);
        throw error;
      }
    },
    onSuccess: (schedule) => applyScheduleView(client, schedule),
  });
}

export function useRemoveSchedule(slug: string) {
  const backend = useBackend();
  const client = useQueryClient();

  return useMutation({
    mutationFn: () => backend.deleteSchedule(slug),
    onSuccess: () => removeScheduleView(client, slug),
  });
}
