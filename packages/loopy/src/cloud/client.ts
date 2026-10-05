import type {
  Capabilities,
  InspectResponse,
  ProtocolError,
  RunRequest,
  RunResponse,
} from "../protocol/index.js";

export class HostedClientError extends Error {
  constructor(
    readonly status: number,
    readonly error: ProtocolError,
  ) {
    super(error.message);
  }
}

/** Token acquisition belongs to the caller's Clerk session or CLI credential flow. */
export class HostedControlClient {
  private readonly base: URL;
  constructor(
    url: string,
    private readonly token: () => Promise<string>,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.base = new URL(url);
    if (
      this.base.protocol !== "https:" &&
      !(
        this.base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(this.base.hostname)
      )
    )
      throw new Error("Hosted control requires HTTPS");
    if (
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.pathname !== "/"
    )
      throw new Error("Hosted control URL must be an origin");
  }
  private async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.transport(new URL(path, this.base), {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new HostedClientError(response.status, (await response.json()) as ProtocolError);
    return (await response.json()) as T;
  }
  capabilities(): Promise<Capabilities> {
    return this.request("/capabilities");
  }
  admit(request: RunRequest): Promise<RunResponse> {
    return this.request("/runs", "POST", request);
  }
  inspect(runId: string): Promise<InspectResponse> {
    return this.request(`/runs/${encodeURIComponent(runId)}`);
  }
  cancel(runId: string): Promise<{ state: "requested" }> {
    return this.request(`/runs/${encodeURIComponent(runId)}/cancel`, "POST");
  }
}
