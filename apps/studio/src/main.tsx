import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./studio.tsx";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Studio root element is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
