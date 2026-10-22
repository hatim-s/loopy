import { errorResponse } from "./routes.js";

export type OriginPolicy = {
  publicOrigin: string;
  allowedOrigins?: readonly string[];
};

function exactOrigin(value: string): string {
  const url = new URL(value);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname.includes("*") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Trusted origins must be HTTP or HTTPS origins without paths or credentials.");
  }

  return url.origin;
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const HEADERS = new Set(["authorization", "content-type", "accept"]);

/** The host supplies this policy; request headers never extend it. */
export function originSecurity(options: OriginPolicy) {
  const own = exactOrigin(options.publicOrigin);
  const host = new URL(own).host;
  const allowed = new Set([own, ...(options.allowedOrigins ?? []).map(exactOrigin)]);

  function reject(request: Request): Response | undefined {
    const url = new URL(request.url);

    if (url.origin !== own || request.headers.get("host") !== host) {
      return errorResponse("forbidden", "Invalid host.");
    }

    const origin = request.headers.get("origin");

    if (origin !== null && !allowed.has(origin)) {
      return errorResponse("forbidden");
    }

    return undefined;
  }

  function cors(request: Request, response: Response): Response {
    const origin = request.headers.get("origin");
    // Cache decisions for requests without Origin separately too.
    response.headers.append("Vary", "Origin");

    if (origin !== null && allowed.has(origin)) {
      response.headers.set("Access-Control-Allow-Origin", origin);
    }

    return response;
  }

  function preflight(request: Request): Response {
    const method = request.headers.get("access-control-request-method");

    const headers = (request.headers.get("access-control-request-headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);

    if (
      !request.headers.get("origin") ||
      !method ||
      !METHODS.has(method) ||
      headers.some((header) => !HEADERS.has(header))
    ) {
      return cors(request, errorResponse("forbidden", "Invalid preflight."));
    }

    return cors(
      request,
      new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Methods": [...METHODS].join(", "),
          "Access-Control-Allow-Headers": [...HEADERS].join(", "),
          Vary: "Access-Control-Request-Method, Access-Control-Request-Headers",
        },
      }),
    );
  }

  return { reject, cors, preflight };
}
