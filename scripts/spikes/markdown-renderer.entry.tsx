import { createRoot } from "react-dom/client";
import { Markdown } from "../../src/web/components/markdown.tsx";

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(<Markdown text="hi" />);
}
