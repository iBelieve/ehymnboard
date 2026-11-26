// fallow-ignore-file coverage-gaps -- only mounts App (test/client/App.test.tsx); e2e/ loads the real page
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
