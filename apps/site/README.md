# Loopy site

The marketing page, as a Vite + React app.

```sh
bun run --filter @loopy/site dev
```

Then open http://127.0.0.1:4280/. `bun run --filter @loopy/site build` writes `dist/`.

Layout:

- `src/components/` is one file per section: nav, hero, flow (steps plus the stage), runtime, local, start, footer.
- `src/lib/stage.ts` builds and drives the "how it works" animation. It writes SVG elements by hand on an 18 second clock, and it also lights the step rails above it. A declarative port would re-render a few hundred nodes per frame, so it stays imperative behind one mount function.
- `src/lib/hero-field.ts` is the glyph field canvas behind the hero.
- `src/lib/wordmark.ts` fits the footer wordmark to the page width and cuts the bottom 22% of its ink.
- `src/styles/site.css` holds every style. Tokens are at the top.

`prototypes/` keeps the plain HTML explorations this page came from. `prototypes/variants/v7.html` is the one the React app ports. Serve the folder with `python3 -m http.server --directory apps/site/prototypes` to look at them.
