import { useEffect, useState } from "react";
import { applyTheme, currentTheme, type Theme } from "../lib/theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => setTheme(currentTheme()), []);
  const next: Theme = theme === "dark" ? "light" : "dark";

  const flip = () => {
    applyTheme(next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      className="theme"
      onClick={flip}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        {theme === "dark" ? (
          <path
            d="M8 3.25a4.75 4.75 0 1 0 0 9.5V3.25Zm0-1.5a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5Z"
            fill="currentColor"
          />
        ) : (
          <path
            d="M8 3.25a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5Zm0 1.5a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Z"
            fill="currentColor"
          />
        )}
      </svg>
    </button>
  );
}
