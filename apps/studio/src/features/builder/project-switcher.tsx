import type { ProjectList } from "@loopy/contracts";
import { FolderOpen, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ApiClient } from "../../app/api";
import "./projects.css";

export function ProjectSwitcher({ api, dirty = false }: { api: ApiClient; dirty?: boolean }) {
  const titleId = useId();
  const directoryId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [list, setList] = useState<ProjectList>();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setList(await api.request<ProjectList>("/projects"));
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const open = async (directory: string) => {
    if (dirty) {
      setError("Save your graph before switching projects.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.request<{ url: string }>("/projects/open", {
        method: "POST",
        body: JSON.stringify({ path: directory }),
      });
      window.location.assign(result.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const forget = async (id: string) => {
    setBusy(true);
    try {
      await api.request("/projects/forget", { method: "POST", body: JSON.stringify({ id }) });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const current = list?.projects.find((project) => project.current);
  return (
    <>
      <button
        className="project-trigger"
        type="button"
        aria-label="Switch project"
        title={current?.path}
        onClick={() => {
          dialog.current?.showModal();
          void refresh();
        }}
      >
        <FolderOpen aria-hidden="true" /> <span>{current?.name ?? "Projects"}</span>
      </button>
      <dialog className="project-dialog" ref={dialog} aria-labelledby={titleId}>
        <header>
          <h2 id={titleId}>Your projects</h2>
          <button type="button" aria-label="Close projects" onClick={() => dialog.current?.close()}>
            <X />
          </button>
        </header>
        <p>Each project keeps its own graphs and runs. Runs continue when you switch.</p>
        {error ? <p role="alert">{error}</p> : null}
        {dirty ? <p>Save your graph before opening another project.</p> : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void open(path);
          }}
        >
          <label htmlFor={directoryId}>Project directory</label>
          <div className="project-path">
            <input
              id={directoryId}
              placeholder="/absolute/path/to/project"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              required
              disabled={busy}
            />
            <button type="submit" disabled={busy || dirty || !path.trim()}>
              {busy ? "Opening…" : "Open project"}
            </button>
          </div>
        </form>
        <ul>
          {list?.projects.map((project) => (
            <li key={project.id}>
              <div>
                <strong>{project.name}</strong>
                <small>{project.path}</small>
                <span>
                  {project.current
                    ? "Current project"
                    : project.running
                      ? "Server running"
                      : "Server stopped"}
                </span>
              </div>
              {!project.current ? (
                <div className="project-actions">
                  <button
                    type="button"
                    disabled={busy || dirty}
                    onClick={() => void open(project.path)}
                  >
                    Open {project.name}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void forget(project.id)}
                    aria-label={`Remove ${project.name} from list`}
                  >
                    Remove from list
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </dialog>
    </>
  );
}
