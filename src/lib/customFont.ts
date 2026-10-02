interface StoredFont { name: string; data: ArrayBuffer }
const MAX_FONT_BYTES = 2 * 1024 * 1024;
let active: FontFace | null = null;
let pending: Promise<unknown> = Promise.resolve();

// Serialize restoration and replacement so an earlier read cannot replace a new upload.
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation, operation);
  pending = result.catch(() => undefined);
  return result;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("Custom font storage is unavailable in this browser.")); return; }
    const request = indexedDB.open("vn-reader-custom-font", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("fonts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Custom font storage is unavailable in this browser."));
    request.onblocked = () => reject(new Error("Close other reader tabs and try adding the font again."));
  });
}
async function store(value?: StoredFont): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("fonts", "readwrite");
      const fonts = transaction.objectStore("fonts");
      if (value) fonts.put(value, "current"); else fonts.delete("current");
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error("Could not save the custom font. Browser storage may be full or unavailable."));
    });
  } finally { db.close(); }
}
async function loadFont(data: ArrayBuffer): Promise<FontFace> {
  if (typeof FontFace === "undefined" || !document.fonts) throw new Error("Custom fonts are not supported by this browser.");
  try { return await new FontFace("VN Custom", data).load(); }
  catch { throw new Error("This file could not be read as a font. Choose another WOFF2, WOFF, TTF or OTF file."); }
}
function activate(font: FontFace): void {
  document.fonts.add(font);
  if (active) document.fonts.delete(active);
  active = font;
  document.documentElement.style.setProperty("--custom", '"VN Custom", var(--sans)');
}
export function restoreCustomFont(): Promise<string> {
  return serialize(async () => {
    const db = await database();
    try {
      const value = await new Promise<StoredFont | undefined>((resolve, reject) => {
        const request = db.transaction("fonts").objectStore("fonts").get("current");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error("Could not restore the saved font. Aspekta is available instead."));
      });
      if (!value) return "";
      if (typeof value.name !== "string" || !(value.data instanceof ArrayBuffer) || !value.data.byteLength || value.data.byteLength > MAX_FONT_BYTES) {
        throw new Error("The saved font is unavailable. Add it again to use it on this device.");
      }
      activate(await loadFont(value.data));
      return value.name;
    } finally { db.close(); }
  });
}
export function uploadCustomFont(file: File): Promise<string> {
  return serialize(async () => {
    if (!/\.(woff2?|ttf|otf)$/i.test(file.name) || !file.size || file.size > MAX_FONT_BYTES) {
      throw new Error("Choose a WOFF2, WOFF, TTF or OTF font up to 2 MB.");
    }
    const data = await file.arrayBuffer();
    const font = await loadFont(data);
    const name = file.name.slice(0, 100);
    // Keep the previous font active if validation or persistence fails.
    await store({ name, data });
    activate(font);
    return name;
  });
}
export function removeCustomFont(): Promise<void> {
  return serialize(async () => {
    await store();
    if (active) document.fonts.delete(active);
    active = null;
    document.documentElement.style.setProperty("--custom", "var(--sans)");
  });
}
