// Share and search metadata for pages that link previews can't learn from the
// single-page app: each form, each custom share link, and the sitemap.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const escape = value => String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const trim = (value, length) => { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text.length > length ? `${text.slice(0, length - 1).replace(/\s+\S*$/, "")}…` : text; };

export const SITE = {
  name: "VidurNeeti",
  title: "VidurNeeti · Vidura’s counsel, the Geeta’s path",
  description: "Clear-eyed commentary on India, drawn from Vidura of the Mahabharata and the Shrimad Bhagavad Geeta. Read every post in VN Reader, or join Ground Work.",
  image: "/og/vidurneeti.png"
};

/** Replace whatever title, description, canonical, Open Graph and Twitter tags the page has with these. */
export function withMeta(html, { title, description, url, image, imageAlt, type = "website", robots }) {
  const head = [
    `<title>${escape(title)}</title>`,
    `<meta name="description" content="${escape(description)}" />`,
    robots ? `<meta name="robots" content="${escape(robots)}" />` : "",
    `<link rel="canonical" href="${escape(url)}" />`,
    `<meta property="og:type" content="${escape(type)}" />`,
    `<meta property="og:site_name" content="${SITE.name}" />`,
    `<meta property="og:title" content="${escape(title)}" />`,
    `<meta property="og:description" content="${escape(description)}" />`,
    `<meta property="og:url" content="${escape(url)}" />`,
    `<meta property="og:image" content="${escape(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${escape(imageAlt ?? title)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escape(title)}" />`,
    `<meta name="twitter:description" content="${escape(description)}" />`,
    `<meta name="twitter:image" content="${escape(image)}" />`
  ].filter(Boolean).join("\n    ");
  const cleaned = html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+(name|property)="(description|robots|og:[^"]*|twitter:[^"]*)"[^>]*>\s*/gi, "")
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "")
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\s*/i, "");
  return cleaned.replace(/<\/head>/i, `    ${head}\n  </head>`);
}

export function createSeo({ store, origin, indexPath = process.env.VN_WEB_INDEX || resolve("web/index.html") }) {
  let template = null, loadedAt = 0;
  const shell = () => {
    try { const changed = statSync(indexPath).mtimeMs; if (!template || changed !== loadedAt) { template = readFileSync(indexPath, "utf8"); loadedAt = changed; } }
    catch { template = null; }
    return template;
  };
  const absolute = path => new URL(path, origin).href;

  function formMeta(form, path) {
    const info = store.shareImageInfo(form.id);
    const live = form.status === "live";
    return {
      title: `${form.title} · ${SITE.name}`,
      description: trim(form.description || `Fill the ${form.title} form on ${SITE.name}.`, 200),
      url: absolute(path),
      image: info ? absolute(`/api/forms/${encodeURIComponent(form.slug)}/share-image?v=${info.updatedAt}`) : absolute(SITE.image),
      imageAlt: form.title,
      robots: live ? undefined : "noindex"
    };
  }

  function send(res, meta, status = 200) {
    const html = shell();
    if (!html) return res.status(503).type("text/plain").send("The site is starting. Please refresh in a moment.");
    res.status(status).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate", "Referrer-Policy": "strict-origin-when-cross-origin" }).send(withMeta(html, meta));
  }
  const siteMeta = path => ({ ...SITE, url: absolute(path), image: absolute(SITE.image) });

  function mount(app) {
    app.get("/f/:slug", (req, res) => {
      const form = store.formBySlug(String(req.params.slug));
      if (!form || form.status === "draft") return send(res, { ...siteMeta(req.path), robots: "noindex" }, 404);
      send(res, formMeta(form, `/f/${form.slug}`));
    });
    app.get("/go/:code", (req, res) => {
      const link = store.link(String(req.params.code)), form = link && store.form(link.formId);
      if (!form || form.status === "draft") return send(res, { ...siteMeta(req.path), robots: "noindex" }, 404);
      send(res, { ...formMeta(form, `/f/${form.slug}`), robots: "noindex" }); // the canonical address is the form itself
    });
    app.get("/sitemap.xml", (req, res) => {
      const forms = store.database.prepare("SELECT slug,updated_at FROM forms WHERE status='live' ORDER BY updated_at DESC").all().map(row => ({ slug: row.slug, updatedAt: row.updated_at }));
      const urls = [{ loc: absolute("/"), priority: "1.0" }, ...forms.map(form => ({ loc: absolute(`/f/${form.slug}`), priority: "0.8", lastmod: new Date(form.updatedAt).toISOString().slice(0, 10) }))];
      res.set({ "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" }).send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(url => `  <url><loc>${escape(url.loc)}</loc>${url.lastmod ? `<lastmod>${url.lastmod}</lastmod>` : ""}<priority>${url.priority}</priority></url>`).join("\n")}\n</urlset>\n`);
    });
  }
  return { mount, withMeta, formMeta };
}
