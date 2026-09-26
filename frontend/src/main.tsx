import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import LabelTool from "./labeling/LabelTool";
import "./index.css";

/** `#label` opens the lane labeling tool; anything else is the demo. */
function Root() {
  const [labeling, setLabeling] = useState(() => location.hash.startsWith("#label"));
  useEffect(() => {
    const onHash = () => setLabeling(location.hash.startsWith("#label"));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return labeling ? <LabelTool /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
