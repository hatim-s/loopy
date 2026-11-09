import { errorResponse } from "../../service";

/**
 * The listener serves only its own origin. A request for another host, or sent by a page on
 * another origin, is refused before auth, so no other site can drive the daemon from a browser.
 */
export function rejectForeign(request: Request, origin: string): Response | undefined {
  const url = new URL(request.url);

  if (url.origin !== origin || request.headers.get("host") !== url.host) {
    return errorResponse("forbidden", "Invalid host.");
  }

  const from = request.headers.get("origin");

  return from !== null && from !== origin ? errorResponse("forbidden") : undefined;
}
