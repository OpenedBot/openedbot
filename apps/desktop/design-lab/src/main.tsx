import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, NavLink, Outlet, RouterProvider, useSearchParams } from "react-router";
import { Toolbar } from "./components/Toolbar";
import { Compare } from "./pages/Compare";
import { Gallery } from "./pages/Gallery";
import { TemplateDetail } from "./pages/TemplateDetail";
import "./styles.css";

function Layout() {
  const [params] = useSearchParams();
  // Keep the preview controls when moving between pages.
  const keep = new URLSearchParams(params);
  keep.delete("names");
  const suffix = keep.toString() ? `?${keep}` : "";
  return (
    <div className="lab">
      <header className="lab-head">
        <NavLink to={`/${suffix}`} className="lab-brand" end>
          <img src="/assets/openedbot-icon.webp" alt="" width="24" height="24" />
          openedbot design lab
        </NavLink>
        <Toolbar />
      </header>
      <main className="lab-main">
        <Outlet />
      </main>
    </div>
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Gallery /> },
      { path: "t/:name", element: <TemplateDetail /> },
      { path: "compare", element: <Compare /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
