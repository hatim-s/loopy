const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];

export function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTS.includes(url.hostname);
}

/** A bare loopback HTTP origin, without credentials, path, query or fragment. */
export function isLoopbackOrigin(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    isLoopbackUrl(url) &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  );
}
