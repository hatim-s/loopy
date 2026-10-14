import { useEffect, useState } from "react";
import { Mark } from "./defs";
import { ThemeToggle } from "./theme-toggle";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(scrollY > 8);
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });

    return () => removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={scrolled ? "nav scrolled" : "nav"}>
      <div className="wrap">
        <ThemeToggle />
        <Mark label="Loopy home" />
        <nav className="nav-links" aria-label="Primary">
          <a href="#docs">Docs</a>
          <a href="#how" className="hide-sm">
            Examples
          </a>
          <a href="#github">GitHub</a>
        </nav>
        <a className="btn btn-accent" href="#start">
          Install
        </a>
      </div>
    </header>
  );
}
