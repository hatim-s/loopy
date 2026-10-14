import type { ReactNode } from "react";
import { useReveal } from "../hooks/use-reveal";
import { stagger } from "../lib/stagger";

type Control = { title: string; body: ReactNode; icon: ReactNode };

const CONTROLS: Control[] = [
  {
    title: "Branching",
    body: "Conditions route the run down one edge or another.",
    icon: (
      <>
        <path className="s" d="M2 14h12" />
        <path className="a" d="M14 14c8 0 8-10 16-10h12" />
        <path className="s" d="M14 14c8 0 8 10 16 10h12" />
        <circle className="d" cx="14" cy="14" r="3" />
      </>
    ),
  },
  {
    title: "Parallel joins",
    body: "Fan out to several nodes and wait for all of them.",
    icon: (
      <>
        <path className="a" d="M2 4h12c8 0 8 10 16 10h12" />
        <path className="a" d="M2 24h12c8 0 8-10 16-10" />
        <circle className="d" cx="30" cy="14" r="3" />
      </>
    ),
  },
  {
    title: "Retries",
    body: "Failed nodes retry within your limits, then stop with the error on record.",
    icon: (
      <>
        <path className="s" d="M4 14h36" />
        <path className="a" d="M14 14c0-10 16-10 16 0" />
        <circle cx="14" cy="14" r="3" fill="#F2877E" />
        <circle className="g" cx="30" cy="14" r="3" />
      </>
    ),
  },
  {
    title: "Approvals",
    body: "The run waits until a person says yes.",
    icon: (
      <>
        <path className="s" d="M2 14h14M28 14h14" />
        <circle className="w" cx="22" cy="14" r="6" />
      </>
    ),
  },
  {
    title: "Pause, resume, cancel",
    body: "Stop a run between nodes and pick it up later.",
    icon: (
      <>
        <path className="s" d="M2 14h40" />
        <rect className="d" x="16" y="7" width="3" height="14" rx="1" />
        <rect className="d" x="24" y="7" width="3" height="14" rx="1" />
      </>
    ),
  },
  {
    title: "Replay",
    body: "Run a finished graph again from its recorded inputs.",
    icon: (
      <>
        <path className="s" d="M2 20h40" />
        <path className="a" d="M8 20c0-12 14-12 14-4" />
        <path className="a" d="m19 13 3 3 3-3" />
      </>
    ),
  },
  {
    title: "Checkpoint forks",
    body: "Branch a new run from any checkpoint.",
    icon: (
      <>
        <path className="s" d="M2 18h40" />
        <path className="a" d="M18 18c6 0 6-12 12-12h12" />
        <circle className="d" cx="18" cy="18" r="3" />
      </>
    ),
  },
  {
    title: "Schedules",
    body: (
      <>
        Put a loopy on cron. <code>0 9 * * *</code> runs it every morning.
      </>
    ),
    icon: (
      <>
        <circle className="s" cx="22" cy="14" r="11" />
        <path className="a" d="M22 14V7M22 14l5 3" />
      </>
    ),
  },
];

export function Runtime() {
  const section = useReveal<HTMLElement>();

  return (
    <section className="rt" id="runtime" aria-labelledby="rt-h" ref={section}>
      <div className="wrap grid">
        <h2 id="rt-h" className="rv" style={stagger(0)}>
          The agent does the work. The graph decides what happens next.
        </h2>
        <p className="sub rv" style={stagger(1)}>
          Inside a node the agent loops as long as it needs. Between nodes, Loopy runs plain rules
          you can read.
        </p>
        <div className="controls">
          {CONTROLS.map((c, i) => (
            <div className="ctl rv" style={stagger(2 + (i >> 1))} key={c.title}>
              <svg viewBox="0 0 44 28" aria-hidden="true">
                {c.icon}
              </svg>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
