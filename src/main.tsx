import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { captureTelegramLaunch } from "./forms/api";
import "./scrollbars.css";

// Three separate surfaces share one bundle entry: the reader, public forms, and the admin console.
// Each loads only its own code and styles; links between them are full page navigations.
captureTelegramLaunch();
const path = window.location.pathname.replace(/\/+$/, "") || "/";
const Reader = lazy(() => import("./ReaderRoot"));
const FormPage = lazy(() => import("./forms/FormPage"));
const AdminApp = lazy(() => import("./admin/AdminApp"));

function Root() {
  const form = /^\/f\/([a-z0-9-]{1,48})$/.exec(path), link = /^\/go\/([a-z0-9-]{1,48})$/.exec(path);
  if (path === "/admin" || path.startsWith("/admin/")) return <AdminApp />;
  if (form) return <FormPage slug={form[1]} />;
  if (link) return <FormPage linkCode={link[1]} />;
  return <Reader />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </React.StrictMode>
);
