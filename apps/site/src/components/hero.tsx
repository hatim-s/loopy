import { useEffect, useRef } from "react";
import { mountHeroField } from "../lib/hero-field";
import { stagger } from "../lib/stagger";
import { CopyButton } from "./copy-button";

const INSTALL = "bun add -g loopy";

const LINES = ["Do the work once.", "Extract the graph.", "Run it with control."];

export function Hero() {
  const hero = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const h = hero.current;
    const c = canvas.current;

    if (!h || !c) {
      return;
    }

    // the hero plays on load, once the fonts are in or 400ms has passed, whichever is first
    let alive = true;
    const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
    Promise.race([fonts, new Promise((r) => setTimeout(r, 400))]).then(
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
            Finish a task once in your agent CLI, and Loopy turns that session into a graph you can
            read, edit and run again on your own machine.
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
            Then open <code>loopy studio</code> and point it at a session.
          </p>
        </div>
      </div>
    </section>
  );
}
