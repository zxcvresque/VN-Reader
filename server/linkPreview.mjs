// Link previews for the reader: title, description, image and whether the page
// may be shown inside the reader's viewer. Fetches only public http(s) addresses.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

const MAX_BYTES = 600 * 1024, TIMEOUT_MS = 6000, MAX_REDIRECTS = 4;
const TTL_MS = 6 * 3600000, FAIL_TTL_MS = 10 * 60000, CACHE_SIZE = 1500;

/** True for loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses. */
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
    if (mapped) return isPrivateAddress(mapped);
    return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8");
  }
  return true;
}

/** DNS lookup that refuses non-public answers. Used by the socket itself, so a rebinding answer can't slip past. */
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    const safe = addresses.filter(item => !isPrivateAddress(item.address));
    if (!safe.length) return callback(Object.assign(new Error("Address not allowed"), { code: "EBLOCKED" }));
    if (options?.all) return callback(null, safe);
    callback(null, safe[0].address, safe[0].family);
  });
}

export function normalizeUrl(input) {
  let url;
  try { url = new URL(String(input ?? "").trim()); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) return null;
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""))) return null;
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(url.hostname)) return null;
  url.hash = "";
  return url;
}

function request(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, { method: "GET", lookup: publicLookup, timeout: TIMEOUT_MS, headers: {
      "User-Agent": "Mozilla/5.0 (compatible; VidurneetiPreview/1.0; +https://vidurneeti.xyz)",
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "en-IN,en;q=0.9,hi;q=0.6"
    } }, response => {
      const chunks = []; let size = 0;
      const type = String(response.headers["content-type"] ?? "");
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); return resolve({ status: response.statusCode, headers: response.headers, body: "" }); }
      if (!/html|xml/i.test(type)) { response.destroy(); return resolve({ status: response.statusCode, headers: response.headers, body: "", type }); }
      response.on("data", chunk => { size += chunk.length; if (size > MAX_BYTES) { response.destroy(); return; } chunks.push(chunk); });
      response.on("close", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8"), type }));
      response.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

const decode = text => String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (match, code) => {
  const lower = code.toLowerCase();
  if (lower[0] === "#") { const value = lower[1] === "x" ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10); return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : ""; }
  return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[lower] ?? match;
}).replace(/\s+/g, " ").trim();

/** Pull Open Graph, Twitter and plain HTML metadata out of the <head>. */
export function parseMeta(html, base) {
  const head = html.slice(0, html.search(/<\/head>/i) > 0 ? html.search(/<\/head>/i) : 200000);
  const meta = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = name => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    const key = (attr("property") ?? attr("name"))?.slice(2).find(value => value !== undefined)?.toLowerCase();
    const content = attr("content")?.slice(2).find(value => value !== undefined);
    if (key && content !== undefined && !(key in meta)) meta[key] = decode(content);
  }
  const absolute = value => { try { const url = new URL(value, base); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; } };
  const title = meta["og:title"] || meta["twitter:title"] || decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "");
  const iconTag = (head.match(/<link\b[^>]*rel\s*=\s*["']?[^"'>]*icon[^"'>]*["']?[^>]*>/gi) ?? [])[0];
  const icon = iconTag ? /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(iconTag)?.slice(2).find(value => value !== undefined) : "/favicon.ico";
  return {
    title: title.slice(0, 300),
    description: (meta["og:description"] || meta["twitter:description"] || meta.description || "").slice(0, 500),
    image: absolute(meta["og:image:secure_url"] || meta["og:image"] || meta["twitter:image"] || meta["twitter:image:src"] || "") ?? "",
    siteName: (meta["og:site_name"] || "").slice(0, 120),
    icon: absolute(icon ?? "") ?? ""
  };
}

/** Whether the response allows being shown inside another site's frame. */
export function frameable(headers, url, ourOrigin) {
  if (url.protocol !== "https:") return false; // an http page inside an https site is blocked by browsers
  if (headers["x-frame-options"]) return false;
  const csp = [headers["content-security-policy"]].flat().filter(Boolean).join(";");
  const ancestors = /frame-ancestors([^;]*)/i.exec(csp)?.[1]?.trim();
  if (ancestors === undefined) return true;
  const sources = ancestors.split(/\s+/).filter(Boolean);
  return sources.includes("*") || (!!ourOrigin && sources.some(source => source === ourOrigin || source === new URL(ourOrigin).host || (source.startsWith("https://*.") && new URL(ourOrigin).host.endsWith(source.slice(9)))));
}

/** Pages that block framing but publish an embeddable player. */
export function embedFor(url) {
  const host = url.hostname.replace(/^www\.|^m\./, "");
  let id = null;
  if (host === "youtu.be") id = url.pathname.slice(1);
  else if (host === "youtube.com" && url.pathname === "/watch") id = url.searchParams.get("v");
  else if (host === "youtube.com" && /^\/(shorts|live)\//.test(url.pathname)) id = url.pathname.split("/")[2];
  if (id && /^[\w-]{6,20}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
  return null;
}

export function createLinkPreviews({ origin, now = () => Date.now() } = {}) {
  const cache = new Map(), pending = new Map(), hits = new Map();
  const remember = (key, value, ttl) => { cache.delete(key); cache.set(key, { value, expires: now() + ttl }); while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value); };

  async function load(url) {
    let current = url, response;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await request(current);
      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        const next = normalizeUrl(new URL(response.headers.location, current).href);
        if (!next) throw Object.assign(new Error("Redirect not allowed"), { code: "EBLOCKED" });
        current = next; continue;
      }
      break;
    }
    const meta = response.body ? parseMeta(response.body, current) : { title: "", description: "", image: "", siteName: "", icon: "" };
    const embed = embedFor(url) ?? embedFor(current);
    return {
      url: url.href, finalUrl: current.href, host: current.hostname.replace(/^www\./, ""),
      ...meta, title: meta.title || current.hostname.replace(/^www\./, ""),
      embed: embed ?? (response.status < 400 && frameable(response.headers, current, origin) ? current.href : null),
      ok: response.status < 400
    };
  }

  async function preview(input) {
    const url = normalizeUrl(input);
    if (!url) return null;
    const key = url.href, cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const job = load(url).then(value => { remember(key, value, TTL_MS); return value; }, () => {
      const host = url.hostname.replace(/^www\./, "");
      const value = { url: url.href, finalUrl: url.href, host, title: host, description: "", image: "", siteName: "", icon: "", embed: embedFor(url), ok: false };
      remember(key, value, FAIL_TTL_MS); return value;
    }).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }

  /** At most 90 previews a minute per address; cached answers don't count. */
  function allowed(ip) {
    const minute = Math.floor(now() / 60000), entry = hits.get(ip);
    if (!entry || entry.minute !== minute) { hits.set(ip, { minute, count: 1 }); if (hits.size > 5000) hits.clear(); return true; }
    return ++entry.count <= 90;
  }

  function mount(app) {
    app.get("/api/link-preview", async (req, res) => {
      const url = normalizeUrl(req.query.url);
      if (!url) return res.status(422).json({ detail: "Only public web addresses can be previewed." });
      const cached = cache.get(url.href);
      if (!(cached && cached.expires > now()) && !allowed(String(req.headers["x-forwarded-for"] ?? req.ip))) return res.status(429).json({ detail: "Too many previews. Try again in a minute." });
      try { const value = await preview(url.href); res.set("Cache-Control", "public, max-age=3600"); res.json(value); }
      catch { res.status(502).json({ detail: "The page couldn't be reached." }); }
    });
  }
  return { preview, mount };
}
