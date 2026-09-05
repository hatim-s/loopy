import type { ToolStatus } from "@loopy/tools";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../app/api";
import "./tools.css";

export function ToolLibrary({ api }: { api: ApiClient }) {
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<ToolStatus>();
  const [installing, setInstalling] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const result = await api.request<{ tools: ToolStatus[] }>("/tools");
      setTools(result.tools);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const install = async () => {
    if (!selected) return;
    setInstalling(selected.id);
    setSelected(undefined);
    try {
      await api.request(`/tools/${encodeURIComponent(selected.id)}/install`, {
        method: "POST",
        body: "{}",
      });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setInstalling(undefined);
    }
  };
  return (
    <section className="tool-library" aria-label="Local CLIs">
      <header>
        <div>
          <h2>Local CLIs</h2>
          <p>Install tools once. Agents and shell modules use them from your computer.</p>
        </div>
        <button type="button" onClick={() => void refresh()}>
          Refresh tools
        </button>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      <div className="tool-library-grid">
        {tools.map((tool) => (
          <article key={tool.id}>
            <div>
              <strong>{tool.name}</strong>
              <small>{tool.category}</small>
            </div>
            <span className={tool.installed ? "tool-ready" : "tool-missing"}>
              {tool.installed
                ? "Installed"
                : installing === tool.id
                  ? "Installing…"
                  : "Not installed"}
            </span>
            {tool.installed ? (
              <>
                <code>{tool.binary}</code>
                {tool.loginHint ? (
                  <p>
                    Sign in from a terminal with <code>{tool.loginHint}</code>
                  </p>
                ) : null}
              </>
            ) : (
              <>
                {tool.install ? (
                  <code>{tool.install.command}</code>
                ) : (
                  <p>Install this tool with your operating system's package manager.</p>
                )}
                <button
                  type="button"
                  disabled={Boolean(installing) || !tool.install?.available}
                  onClick={() => setSelected(tool)}
                >
                  Install {tool.name}
                </button>
                {tool.install?.reason ? <p>{tool.install.reason}</p> : null}
              </>
            )}
          </article>
        ))}
      </div>
      {selected ? (
        <dialog open className="tool-install-dialog" aria-label={`Install ${selected.name}`}>
          <h2>Install {selected.name}</h2>
          <p>Loopy will run this command on your computer.</p>
          <pre>{selected.install?.command}</pre>
          <button type="button" onClick={() => setSelected(undefined)}>
            Cancel
          </button>
          <button type="button" onClick={() => void install()}>
            Run installation
          </button>
        </dialog>
      ) : null}
    </section>
  );
}
