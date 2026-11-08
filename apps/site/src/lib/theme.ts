export type Theme = "dark" | "light";

const KEY = "loopy-theme";

export const THEME_COLOR = { dark: "#0d1014", light: "#f7f8fa" } as const;

// vite.config.ts inlines this into index.html so the saved theme applies before first paint
// and a light-mode visitor never sees a dark flash. It must stay plain browser JavaScript.
export const THEME_BOOT = `(() => {
  const saved = localStorage.getItem(${JSON.stringify(KEY)});
  const light = saved ? saved === "light" : matchMedia("(prefers-color-scheme: light)").matches;
  if (light) {
    document.documentElement.dataset.theme = "light";
    document.querySelector('meta[name="theme-color"]').content = ${JSON.stringify(THEME_COLOR.light)};
  }
})();`;

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
  localStorage.setItem(KEY, theme);
}

export function onThemeChange(cb: (theme: Theme) => void) {
  const mo = new MutationObserver(() => cb(currentTheme()));
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return () => mo.disconnect();
}
