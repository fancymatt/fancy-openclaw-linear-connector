import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "@fancyfleet/tokens/connector.css";
import "@fancyfleet/components/styles.css";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
