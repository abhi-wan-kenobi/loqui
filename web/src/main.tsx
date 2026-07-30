import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing from index.html");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[sw] registration failed", err);
    });
  });
}
