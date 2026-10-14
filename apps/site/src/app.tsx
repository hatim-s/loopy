import { Defs } from "./components/defs";
import { Flow } from "./components/flow";
import { Footer } from "./components/footer";
import { Hero } from "./components/hero";
import { Local } from "./components/local";
import { Nav } from "./components/nav";
import { Runtime } from "./components/runtime";
import { Start } from "./components/start";

export function App() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Defs />
      <Nav />
      <main id="main">
        <Hero />
        <Flow />
        <Runtime />
        <Local />
        <Start />
      </main>
      <Footer />
    </>
  );
}
