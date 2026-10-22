import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { type Access, addressToken, useAccess } from "../../lib/connection.ts";
import { BrandMark } from "../brand-mark.tsx";

type Closed = Exclude<Access, "checking" | "open">;

// A local daemon answers in milliseconds, so wait before showing anything while checking.
const CHECKING_NOTE_MS = 400;

const REASON = {
  missing: {
    title: "Open this page from loopy ui",
    body: () => "The daemon only answers requests that carry its token, and this page has none.",
  },
  rejected: {
    title: "The daemon no longer accepts this page's token",
    body: () => "The daemon issues a new token each time it starts. Get the current address.",
  },
  unreachable: {
    title: "No Loopy daemon answered",
    body: (apiUrl: string) => (
      <>
        Nothing answered at <code className="text-ink">{apiUrl}</code>. <code>loopy ui</code> starts
        the daemon if it is not running.
      </>
    ),
  },
} as const satisfies Record<Closed, { title: string; body: (apiUrl: string) => ReactNode }>;

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-full place-items-center px-6 py-12">
      <div className="w-full max-w-[460px]">
        <p className="mb-8 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
          <BrandMark className="size-[18px] text-lamp" />
          loopy
        </p>
        {children}
      </div>
    </main>
  );
}

function Checking() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShown(true), CHECKING_NOTE_MS);

    return () => clearTimeout(timer);
  }, []);

  return shown ? <p className="text-muted">Connecting to the Loopy daemon.</p> : null;
}

/** Takes the token out of a pasted address and boots the page with it, as `loopy ui` would. */
function AddressForm() {
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const hint = useId();

  function connect(event: FormEvent) {
    event.preventDefault();
    const token = URL.canParse(address) ? addressToken(new URL(address)) : null;

    if (token === null) {
      setInvalid(true);

      return;
    }

    // Boot reads the token from the fragment, stores it and strips it from the address bar.
    history.replaceState(null, "", `#${new URLSearchParams({ token })}`);
    location.reload();
  }

  return (
    <form onSubmit={connect} className="mt-4 space-y-1">
      <label className="block space-y-1">
        <span className="text-xs text-muted">Address from loopy ui</span>
        <span className="flex gap-2">
          <input
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setInvalid(false);
            }}
            placeholder="http://127.0.0.1:4310/#token=…"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid}
            aria-describedby={invalid ? hint : undefined}
            className="field field-mono min-w-0 flex-1"
          />
          <button type="submit" className="btn btn-primary" disabled={address.trim() === ""}>
            Connect
          </button>
        </span>
      </label>
      {invalid && (
        <p id={hint} className="text-xs text-danger">
          Paste the whole address, including the #token= part.
        </p>
      )}
    </form>
  );
}

/**
 * Shows the dashboard only while the API accepts this page. Otherwise it explains how to get a
 * working address, so a missing or stale token is one message instead of a page of failures.
 */
export function AccessGate(props: { apiUrl: string; retry: () => void; children: ReactNode }) {
  const { apiUrl, retry, children } = props;
  const access = useAccess();

  if (access === "open") {
    return children;
  }

  if (access === "checking") {
    return (
      <Frame>
        <Checking />
      </Frame>
    );
  }

  const reason = REASON[access];

  return (
    <Frame>
      <h1>{reason.title}</h1>
      <p className="mt-2 text-muted">{reason.body(apiUrl)}</p>
      <p className="mt-6 text-xs text-muted">Run this in a terminal:</p>
      <pre className="mt-1.5 rounded-control border border-line bg-sunken px-3 py-2.5 text-ink">
        <span aria-hidden="true" className="text-faint">
          ${" "}
        </span>
        loopy ui
      </pre>
      <p className="mt-3 text-muted">
        It prints an address. Open it, or paste it here to keep using this page.
      </p>
      <AddressForm />
      {access === "unreachable" && (
        <button type="button" className="btn mt-6" onClick={retry}>
          Try again
        </button>
      )}
    </Frame>
  );
}
