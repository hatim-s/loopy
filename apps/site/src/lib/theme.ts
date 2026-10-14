export type Theme = "dark" | "light";

const KEY = "loopy-theme";

const META = { dark: "#0d1014", light: "#f7f8fa" } as const;

// The inline script in index.html applies the saved theme before first paint.
// This module owns the same attribute afterwards, so both read the same key.
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META[theme]);
  localStorage.setItem(KEY, theme);
}

/** Runs cb when the html data-theme attribute changes. Returns a disconnect function. */
export function onThemeChange(cb: (theme: Theme) => void) {
  const mo = new MutationObserver(() => cb(currentTheme()));
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return () => mo.disconnect();
}
