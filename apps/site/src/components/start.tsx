import { useReveal } from "../hooks/use-reveal";
import { stagger } from "../lib/stagger";
import { CopyButton } from "./copy-button";

const INSTALL = "bun add -g loopy";

const CMDS = [
  { cmd: INSTALL, note: "Install the CLI", copy: true },
  { cmd: "loopy import session.json --provider codex", note: "Bring in the session" },
  { cmd: "loopy extract --import <id>", note: "Get a graph back" },
  { cmd: "loopy studio", note: "Read it, edit it, run it" },
];

export function Start() {
  const section = useReveal<HTMLElement>();

  return (
    <section className="start" id="start" aria-labelledby="start-h" ref={section}>
      <div className="wrap grid">
        <h2 id="start-h" className="rv" style={stagger(0)}>
          Pick one task you did this week.
        </h2>
        <ol className="cmds" id="docs">
          {CMDS.map((c, i) => (
            <li className="rv" style={stagger(i + 1)} key={c.cmd}>
              <span>
                <span className="p">$ </span>
                {c.cmd}
              </span>
              {c.copy ? <CopyButton text={c.cmd} /> : null}
              <span className="n">{c.note}</span>
            </li>
          ))}
        </ol>
        <div className="links rv" style={stagger(5)}>
          <a className="btn btn-accent" href="#docs">
            Read the docs
          </a>
          <a className="btn" href="#github">
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
