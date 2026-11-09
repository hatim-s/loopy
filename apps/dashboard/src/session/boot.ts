export type Session = { baseUrl: string; token: string | null };

export function httpBaseUrl(value: string): string {
  const url = new URL(value);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("API base URL must use HTTP or HTTPS without credentials, query or fragment.");
  }

  return url.href.replace(/\/+$/, "");
}

export function addressToken(address: URL): string | null {
  return new URLSearchParams(address.hash.slice(1)).get("token") || null;
}

/** The fragment is a bootstrap secret, so remove it before touching storage. */
export function bootSession(options: {
  baseUrl: string;
  pageUrl: string;
  storage: () => Pick<Storage, "getItem" | "setItem">;
  replaceUrl: (url: string) => void;
}): Session {
  const page = new URL(options.pageUrl);
  const fragment = new URLSearchParams(page.hash.slice(1));
  const token = addressToken(page);

  if (fragment.has("token")) {
    fragment.delete("token");
    page.hash = fragment.toString();
    options.replaceUrl(page.href);
  }

  const baseUrl = httpBaseUrl(options.baseUrl);
  const key = `loopy-token:${baseUrl}`;
  let stored: string | null = null;

  try {
    const storage = options.storage();

    if (token) {
      storage.setItem(key, token);
    }

    stored = storage.getItem(key);
  } catch {
    // A blocked storage API must not leave the bootstrap token in the URL.
  }

  return { baseUrl, token: token ?? stored };
}

/** Puts a pasted address's token in the fragment and reloads, so boot handles it as usual. */
export function adoptToken(token: string): void {
  history.replaceState(null, "", `#${new URLSearchParams({ token })}`);
  location.reload();
}

/**
 * Pasting a fresh `loopy ui` address over this page only changes the fragment, which does not
 * reload, so reload here and let boot pick up the new token.
 */
export function reloadOnNewAddress(): void {
  window.addEventListener("hashchange", () => {
    if (addressToken(new URL(window.location.href)) !== null) {
      window.location.reload();
    }
  });
}
