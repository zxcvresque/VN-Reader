import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Use the production CSS in its compiled order, including the real Aspekta font.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtIndex = readFileSync(resolve(root, "dist/index.html"), "utf8");
const stylesheet = builtIndex.match(/href="(\/assets\/[^\"]+\.css)"/);
if (!stylesheet) throw new Error("Run the production build before exporting the preview.");
const font = readFileSync(resolve(root, "public/fonts/AspektaVF.woff2")).toString("base64");
const fontLicense = readFileSync(resolve(root, "public/fonts/Aspekta-LICENSE.txt"), "utf8");
const css = readFileSync(resolve(root, `dist${stylesheet[1]}`), "utf8")
  .replaceAll("/fonts/AspektaVF.woff2", `data:font/woff2;base64,${font}`);

// This is the loading branch of App.tsx, held open so it can be inspected.
const html = `<!doctype html>
<html lang="en" data-theme="vercel" data-nav-position="top" data-paper="theme" data-focus="false">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VN Reader · Current loading screen</title>
  <script type="text/plain" id="embedded-font-license">${fontLicense}</script>
  <style>${css}</style>
  <style>
    .splash-preview-controls { position:fixed; top:16px; right:16px; z-index:10; max-width:calc(100vw - 32px); font:12px/1.5 var(--sans); color:var(--text-muted); }
    .splash-preview-controls summary { cursor:pointer; padding:8px 12px; border:1px solid var(--border-strong); border-radius:var(--radius-sm); background:var(--bg-1); }
    .splash-preview-controls[open] { width:260px; padding:12px; border:1px solid var(--border-strong); border-radius:var(--radius); background:var(--bg-1); box-shadow:var(--shadow-pop); }
    .splash-preview-controls[open] summary { border:0; padding:0 0 12px; }
    .splash-preview-controls label { display:block; margin:8px 0; }
    .splash-preview-controls select { display:block; width:100%; min-height:40px; margin:4px 0; padding:6px 10px; }
    .splash-preview-controls p { margin:12px 0 0; font-size:11px; line-height:1.6; }
    #loading-lines[hidden], #loading-retry[hidden] { display:none!important; }
  </style>
</head>
<body>
  <div id="root">
    <div class="welcome-reader-loading">
      <div id="loading-screen" role="status">
        <h1 id="loading-title">Opening Vidurneeti…</h1>
        <p id="loading-description">Preparing the posts and your saved reading place.</p>
        <div id="loading-lines" class="welcome-loading-lines" aria-hidden="true"><span></span><span></span><span></span></div>
        <button id="loading-retry" hidden type="button" class="btn-primary">Try again</button>
        <button type="button" class="btn-ghost" title="In the reader, this returns to the welcome page.">Back to welcome</button>
      </div>
    </div>
  </div>
  <details class="splash-preview-controls">
    <summary>Preview options</summary>
    <label>Theme<select id="preview-theme"><option value="vercel">Vercel</option><option value="editorial">Editorial</option><option value="cobalt">Cobalt Index</option><option value="opal">Liquid Opal</option></select></label>
    <label>Screen<select id="preview-state"><option value="loading">Loading</option><option value="error">Archive unavailable</option></select></label>
    <p>These options belong to this preview. The loading screen uses the reader’s existing text, styles and font. It stays open here; Back to welcome is shown for visual reference.</p>
  </details>
  <script>
    const theme = document.getElementById('preview-theme');
    const state = document.getElementById('preview-state');
    theme.addEventListener('change', () => document.documentElement.dataset.theme = theme.value);
    const initialTheme = new URLSearchParams(location.search).get('theme');
    if (['vercel','editorial','cobalt','opal'].includes(initialTheme)) {
      theme.value = initialTheme; document.documentElement.dataset.theme = initialTheme;
    }
    function setScreen(value) {
      const loading = value === 'loading';
      state.value = value;
      document.getElementById('loading-screen').setAttribute('role', loading ? 'status' : 'alert');
      document.getElementById('loading-title').textContent = loading ? 'Opening Vidurneeti…' : 'The archive couldn’t be opened.';
      document.getElementById('loading-description').textContent = loading ? 'Preparing the posts and your saved reading place.' : 'The Vidurneeti archive is not connected yet. Please try again shortly.';
      document.getElementById('loading-lines').hidden = !loading;
      document.getElementById('loading-retry').hidden = loading;
    }
    state.addEventListener('change', () => setScreen(state.value));
    document.getElementById('loading-retry').addEventListener('click', () => setScreen('loading'));
  </script>
</body>
</html>`;
mkdirSync(resolve(root, "output"), { recursive: true });
const destination = resolve(root, "output/loading-splash.html");
writeFileSync(destination, html);
console.log(destination);
