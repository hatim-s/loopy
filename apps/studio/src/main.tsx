import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { captureToken } from "./api.ts";
import { App } from "./app.tsx";
import "./style.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Studio root element is missing.");
}

// Runs before any request so the first API call already carries the token.
captureToken();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
