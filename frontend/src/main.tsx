import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import LabelTool from "./labeling/LabelTool";
import CvReview from "./labeling/CvReview";
import "./index.css";

const pageFromHash = () =>
  location.hash.startsWith("#label") ? "label" : location.hash.startsWith("#cv") ? "cv" : "app";

/** `#label` opens the lane labeling tool, `#cv` the CV review; anything else is the demo. */
function Root() {
  const [page, setPage] = useState(pageFromHash);
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (page === "label") return <LabelTool />;
  if (page === "cv") return <CvReview />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
