import { useEffect, useState } from "react";
import type { ApiClient } from "../app/api";
import { ErrorState, LoadingState } from "../components/primitives/states";
import { StatusBadge } from "./components";

type ProviderSetup = {
  provider: string;
  available: boolean;
  version?: string;
  diagnostic?: string;
  readiness?: {
    installation: "installed" | "missing";
    authentication: "authenticated" | "unauthenticated" | "unknown";
    usability: "unverified";
    message: string;
    setupCommand: string;
  };
};

export function ProviderReadiness({ api }: { api: ApiClient }) {
  const [providers, setProviders] = useState<ProviderSetup[]>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setProviders(undefined);
    setError(undefined);
    void api
      .request<{ providers: ProviderSetup[] }>(`/providers?revision=${revision}`)
      .then((result) => {
        if (active) setProviders(result.providers);
      })
      .catch((error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [api, revision]);
  return (
    <section className="panel" aria-label="Provider setup">
      <div className="panel-heading">
        <h2>Provider setup</h2>
        <button
          type="button"
          disabled={!providers && !error}
          onClick={() => setRevision((value) => value + 1)}
        >
          Check again
        </button>
      </div>
      <p>Install and sign in to each CLI from your terminal, then check its status here.</p>
      {error ? <ErrorState message={error} /> : null}
      {!providers && !error ? <LoadingState label="Checking installed providers" /> : null}
      <div className="provider-setup-grid">
        {providers?.map((item) => (
          <article className="provider-setup" key={item.provider}>
            <div className="panel-heading">
              <h3>{item.provider}</h3>
              <StatusBadge status={item.available ? "installed" : "unavailable"} />
            </div>
            {item.version ? <small>Version {item.version}</small> : null}
            <p>
              {item.readiness?.message ??
                item.diagnostic ??
                "Installation detected. Authentication and execution have not been verified."}
            </p>
            {item.readiness ? (
              <>
                <p>
                  Authentication: {item.readiness.authentication}. Execution:{" "}
                  {item.readiness.usability}.
                </p>
                <pre>{item.readiness.setupCommand}</pre>
              </>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
