import { useReveal } from "../hooks/use-reveal";
import { COMMANDS, example, INSTALL } from "../lib/commands";
import { stagger } from "../lib/stagger";
import { CopyButton } from "./copy-button";

const CMDS = [
  { cmd: INSTALL, note: "Install the CLI", copy: true },
  { cmd: example(COMMANDS.save), note: "Compile and store it" },
  { cmd: example(COMMANDS.graph), note: "Print its graph" },
  { cmd: example(COMMANDS.run), note: "Start a run" },
  { cmd: example(COMMANDS.ui), note: "Watch it in the dashboard" },
];

export function Start() {
  const section = useReveal<HTMLElement>();

  return (
    <section className="start" id="start" aria-labelledby="start-h" ref={section}>
      <div className="wrap grid">
        <h2 id="start-h" className="rv" style={stagger(0)}>
          Pick one task you repeat every week.
        </h2>
        <ol className="cmds">
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
      </div>
    </section>
  );
}
