export type ApiClient = {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  getToken(): string | undefined;
};

export type ApiClientOptions = {
  baseUrl?: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  bootstrapPath?: string;
};

type SessionBootstrap = { token?: string };

/** Browser API boundary. The bearer token is scoped to this client closure only. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "/api";
  const fetcher = options.fetcher ?? fetch;
  let token: string | undefined;

  return {
    async request<T>(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      if (init.body && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`, {
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
  const baseUrl = options.baseUrl ?? "/api";
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
  const client = createApiClient(options);
  if (!options.token) return client;
  const token = options.token;
  return {
    ...client,
    async request<T>(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return client.request<T>(path, { ...init, headers });
    },
    getToken: () => token,
  };
}
