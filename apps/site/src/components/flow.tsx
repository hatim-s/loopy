import { useEffect, useRef } from "react";
import { useReveal } from "../hooks/use-reveal";
import { COMMANDS } from "../lib/commands";
import { mountStage } from "../lib/stage";
import { stagger } from "../lib/stagger";

const STEPS = [
  {
    n: "01",
    title: "Save",
    cmd: COMMANDS.save.name,
    body: "Write the task as shell commands, code, branches and approvals in a .loopy.ts file. Save compiles it and stores the graph.",
    icon: <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  },
  {
    n: "02",
    title: "Check",
    cmd: COMMANDS.graph.name,
    body: "Print the compiled nodes and edges, so you see the order before anything runs.",
    icon: (
      <path
        d="M7 1.5 12.5 7 7 12.5 1.5 7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    ),
  },
  {
    n: "03",
    title: "Run",
    cmd: COMMANDS.run.name,
    body: "The local daemon runs the graph on your machine. Loopy owns the order, the retries and the approvals.",
    icon: (
      <path
        d="M3.5 2.2v9.6L11.5 7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    ),
  },
];

export function Flow() {
  const section = useReveal<HTMLElement>();
  const steps = useRef<HTMLOListElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const list = steps.current;

    if (!list || !stage.current || !svg.current) {
      return;
    }

    return mountStage({
      stage: stage.current,
      svg: svg.current,
      steps: [...list.querySelectorAll<HTMLElement>(".step")],
      rails: [...list.querySelectorAll<HTMLElement>(".rail i")],
    });
  }, []);

  return (
    <section className="flow" id="how" aria-labelledby="flow-h" ref={section}>
      <div className="wrap grid">
        <h2 id="flow-h" className="rv" style={stagger(0)}>
          A file goes in. A graph comes out.
        </h2>
        <p className="sub rv" style={stagger(1)}>
          Every command, branch and approval becomes a node you can see.
        </p>
        <ol className="steps" ref={steps}>
          {STEPS.map((s, i) => (
            <li className="step rv" style={stagger(i + 2)} key={s.n}>
              <span className="rail">
                <i />
              </span>
              <div className="num">
                <span>{s.n}</span>
                <svg viewBox="0 0 14 14" aria-hidden="true">
                  {s.icon}
                </svg>
              </div>
              <h3>
                {s.title} <code>{s.cmd}</code>
              </h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
        <div className="stage rv" style={stagger(5)} ref={stage}>
          <svg
            ref={svg}
            viewBox="0 0 1200 600"
            role="img"
            aria-label="A loopy file is saved, its graph appears, and the graph runs. The checks fail once and retry, and the push waits for approval."
          />
        </div>
      </div>
    </section>
  );
}
