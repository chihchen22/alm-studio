import "../design/tokens.css";
import "../design/components.css";
import "./styles/app.css";
import "./styles/guided.css";
// The optional extension folder registers its screens first, when present.
import "./companion";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) throw new Error("root element missing");
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
