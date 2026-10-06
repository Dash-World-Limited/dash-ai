import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppModel } from "./state/app";
import "./styles.css";

const model = new AppModel(window.localStorage);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App model={model} />
  </StrictMode>,
);
