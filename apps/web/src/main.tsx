import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppModel } from "./state/app";
import "./styles.css";

const model = new AppModel(window.localStorage);
// Another tab signed in, switched account or signed out: start again from what is stored now.
window.addEventListener("storage", (e) => {
  if (e.storageArea === window.localStorage && model.sessionChangedElsewhere()) window.location.reload();
});
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App model={model} />
  </StrictMode>,
);
