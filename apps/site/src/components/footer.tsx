import { useEffect, useRef } from "react";
import { mountWordmark } from "../lib/wordmark";
import { LOOP_PATH, Mark } from "./defs";

export function Footer() {
  const wm = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wm.current || !clip.current) {
      return;
    }

    return mountWordmark(wm.current, clip.current);
  }, []);

  return (
    <footer id="github">
      <div className="wrap">
        <div className="foot">
          <Mark size={22} />
          <span>Apache-2.0</span>
          <nav aria-label="Footer">
            <a href="#github">GitHub</a>
            <a href="#docs">Docs</a>
            <a href="#how">Examples</a>
          </nav>
        </div>
      </div>
      <div className="wrap">
        <p className="wm-pre">Get ready to be</p>
      </div>
      <div className="wm-clip" ref={clip}>
        <div className="wm" ref={wm} role="img" aria-label="loop'd">
          <span aria-hidden="true">l</span>
          <svg
            className="oo"
            viewBox="0.9 6.4 22.2 11.2"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path className="lp" d={LOOP_PATH} />
            <circle className="bead" r=".8" fill="var(--accent-ink)">
              <animateMotion dur="9s" repeatCount="indefinite" path={LOOP_PATH} />
            </circle>
          </svg>
          <span aria-hidden="true">p'd</span>
        </div>
      </div>
    </footer>
  );
}
