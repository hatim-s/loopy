import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/site.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Site root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
