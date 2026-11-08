import { useEffect, useRef } from "react";
import { COMMANDS, INSTALL } from "../lib/commands";
import { mountHeroField } from "../lib/hero-field";
import { stagger } from "../lib/stagger";
import { CopyButton } from "./copy-button";

const LINES = ["Write the task once.", "Save it as a graph.", "Run it with control."];

export function Hero() {
  const hero = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const h = hero.current;
    const c = canvas.current;

    if (!h || !c) {
      return;
    }

    // Play once the fonts are in so the lines do not reflow mid-animation, but never wait more than 400ms.
    let alive = true;
    Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 400))]).then(
      () => alive && h.classList.add("in"),
    );
    const unmount = mountHeroField(h, c);

    return () => {
      alive = false;
      unmount();
    };
  }, []);

  return (
    <section className="hero" id="top" ref={hero}>
      <canvas className="bg" ref={canvas} />
      <div className="shade" aria-hidden="true" />
      <div className="wrap grid">
        <h1 className="mask">
          {LINES.map((line, i) => (
            <span className="ln" key={line}>
              <span className="rv" style={stagger(i)}>
                {line}
              </span>
            </span>
          ))}
        </h1>
        <div className="hero-body">
          <p className="sub rv" style={stagger(3)}>
            Describe a task in a <code>.loopy.ts</code> file. Loopy compiles it into a graph you can
            read, run and schedule on your own machine.
          </p>
          <div className="install rv" style={stagger(4)}>
            <span className="cmd">
              <span>
                <span className="p">$ </span>
                {INSTALL}
              </span>
            </span>
            <CopyButton text={INSTALL} />
          </div>
          <p className="then rv" style={stagger(5)}>
            Then open <code>{COMMANDS.ui.name}</code> to watch your runs in the local dashboard.
          </p>
        </div>
      </div>
    </section>
  );
}
