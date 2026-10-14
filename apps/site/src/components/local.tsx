import { useReveal } from "../hooks/use-reveal";
import { stagger } from "../lib/stagger";

const AGENTS = [
  ["Codex", "codex"],
  ["Claude Code", "claude"],
  ["OpenCode", "opencode"],
  ["Pi", "pi"],
] as const;

const FACTS = [
  "Source, credentials, subprocesses and traces stay local.",
  "Run state lives in SQLite on disk. Traces export as JSONL.",
  "Open source under Apache-2.0.",
];

export function Local() {
  const section = useReveal<HTMLElement>();

  return (
    <section className="local" id="local" aria-labelledby="local-h" ref={section}>
      <div className="wrap grid">
        <div className="lead">
          <h2 id="local-h" className="rv" style={stagger(0)}>
            Keep the agent you already use. Your laptop does the work.
          </h2>
          <p className="sub rv" style={stagger(1)}>
            Loopy calls the CLI you have installed, with your login and your settings. No hosted
            compute.
          </p>
        </div>
        <ul className="facts">
          {AGENTS.map(([name, bin], i) => (
            <li className="rv" style={stagger(2 + (i >> 1))} key={bin}>
              <b>{name}</b>
              <code>{bin}</code>
            </li>
          ))}
          {FACTS.map((f, i) => (
            <li className="rv" style={stagger(4 + i)} key={f}>
              {f}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
