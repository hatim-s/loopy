export type ApiClient = {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  getToken(): string | undefined;
  streamEvents(
    runId: string,
    onEvent: (event: Record<string, unknown>) => void,
    options?: { afterSequence?: number; signal?: AbortSignal; onError?: (error: Error) => void },
  ): () => void;
};

export type ApiClientOptions = {
  baseUrl?: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  bootstrapPath?: string;
  token?: string;
};

type SessionBootstrap = { token?: string };

/** Browser API boundary. The bearer token is scoped to this client closure only. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "/api/v1";
  const fetcher = options.fetcher ?? fetch;
  const token = options.token;
  const urlFor = (path: string) => {
    const relative = path.replace(/^\//, "").replace(/^api\//, "");
    return `${baseUrl.replace(/\/$/, "")}/${relative}`;
  };
  const streamEvents: ApiClient["streamEvents"] = (runId, onEvent, streamOptions = {}) => {
    const controller = new AbortController();
    const signal = streamOptions.signal
      ? AbortSignal.any([controller.signal, streamOptions.signal])
      : controller.signal;
    let cursor = streamOptions.afterSequence ?? -1;
    let stopped = false;
    const consume = async () => {
      try {
        const headers = new Headers({ Accept: "text/event-stream" });
        if (cursor >= 0) headers.set("Last-Event-ID", String(cursor));
        if (token) headers.set("Authorization", `Bearer ${token}`);
        const response = await fetcher(urlFor(`/runs/${encodeURIComponent(runId)}/events/stream`), {
          credentials: "include",
          headers,
          signal,
        });
        if (!response.ok)
          throw new ApiError(response.status, response.statusText || "Stream failed");
        if (!response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventName = "message";
        let eventId: number | undefined;
        let data: string[] = [];
        const flush = () => {
          if (!data.length) return;
          const raw = data.join("\n");
          data = [];
          if (eventName !== "heartbeat") {
            try {
              const event = JSON.parse(raw) as Record<string, unknown>;
              if (eventId !== undefined) {
                event.sequence ??= eventId;
                cursor = Math.max(cursor, eventId);
              }
              onEvent(event);
            } catch {
              // A refresh can reconstruct state if a provider emits malformed data.
            }
          }
          eventName = "message";
          eventId = undefined;
        };
        while (!stopped && !signal.aborted) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) {
              flush();
              continue;
            }
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("id:")) eventId = Number(line.slice(3).trim());
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
          if (chunk.done) {
            flush();
            break;
          }
        }
      } catch (error) {
        if (!stopped && !signal.aborted)
          streamOptions.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    };
    void consume();
    return () => {
      stopped = true;
      controller.abort();
    };
  };

  return {
    async request<T>(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      if (init.body && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const response = await fetcher(urlFor(path), {
        ...init,
        credentials: "include",
        headers,
      });
      if (!response.ok)
        throw new ApiError(response.status, response.statusText || "Request failed");
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    },
    getToken: () => token,
    streamEvents,
  };
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Requests a server session using its cookie; the returned token is never persisted. */
export async function bootstrapSession(
  options: ApiClientOptions = {},
): Promise<{ token?: string }> {
  const baseUrl = options.baseUrl ?? "/api/v1";
  const fetcher = options.fetcher ?? fetch;
  const path = options.bootstrapPath ?? "session";
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (response.status === 401 || response.status === 404) return {};
  if (!response.ok)
    throw new ApiError(response.status, response.statusText || "Session bootstrap failed");
  return (await response.json()) as SessionBootstrap;
}

export function createAuthenticatedApiClient(
  options: ApiClientOptions & { token?: string } = {},
): ApiClient {
  return createApiClient(options);
}
