import { QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "./api";

export function createStudioQueryClient(api: ApiClient): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: 1,
        queryFn: ({ queryKey }) => api.request(String(queryKey[0])),
      },
    },
  });
}
