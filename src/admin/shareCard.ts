// Draws a form's 1200×630 share picture: brand, form title, description and link.
import { call, type AdminForm } from "../forms/api";

export const SHARE_W = 1200, SHARE_H = 630;
let fontReady: Promise<void> | null = null;
const loadFont = () => (fontReady ??= (async () => {
  try { const face = new FontFace("AspektaCard", "url(/fonts/AspektaVF.woff2)", { weight: "100 900" }); await face.load(); document.fonts.add(face); } catch { /* falls back to the system sans */ }
})());
const loadImage = (src: string) => new Promise<HTMLImageElement | null>(resolve => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = src; });

function wrap(context: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" "), lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width <= width) { line = next; continue; }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && lines.join(" ").length < text.trim().length) {
    let last = lines[maxLines - 1];
    while (last && context.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.replace(/[\s,.;:]+$/, "")}…`;
  }
  return lines;
}

/** A JPEG of the form's share card. Monochrome glass with the form's accent colour. */
export async function drawShareCard(form: Pick<AdminForm, "title" | "description" | "slug"> & { theme?: { accent?: string } }): Promise<Blob> {
  await loadFont();
  const canvas = document.createElement("canvas"); canvas.width = SHARE_W; canvas.height = SHARE_H;
  const c = canvas.getContext("2d")!;
  const accent = /^#[0-9a-f]{6}$/i.test(form.theme?.accent ?? "") ? form.theme!.accent! : "#f2a23a";
  c.fillStyle = "#070707"; c.fillRect(0, 0, SHARE_W, SHARE_H);
  const glow = (x: number, y: number, r: number, color: string) => { const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, color); g.addColorStop(1, "transparent"); c.fillStyle = g; c.fillRect(0, 0, SHARE_W, SHARE_H); };
  glow(90, 0, 520, "rgba(92,92,92,0.42)"); glow(1200, 440, 600, "rgba(138,138,138,0.28)"); glow(660, 700, 420, `${accent}30`);
  c.save(); c.strokeStyle = "rgba(255,255,255,0.035)"; c.lineWidth = 1;
  for (let x = -SHARE_H; x < SHARE_W + SHARE_H; x += 47) { c.beginPath(); c.moveTo(x, SHARE_H); c.lineTo(x + SHARE_H * Math.tan(Math.PI / 7.2), 0); c.stroke(); }
  c.restore();
  const font = (weight: number, size: number) => `${weight} ${size}px AspektaCard, "Helvetica Neue", Arial, sans-serif`;
  const logo = await loadImage("/VN%20Dark%20Mode%20(Circle).png");
  if (logo) { c.save(); c.beginPath(); c.arc(72 + 32, 64 + 32, 32, 0, Math.PI * 2); c.clip(); c.drawImage(logo, 72, 64, 64, 64); c.restore(); }
  c.fillStyle = "#f4f4f4"; c.font = font(600, 28); c.textBaseline = "middle"; c.fillText("VidurNeeti", logo ? 152 : 72, 96);
  c.textBaseline = "alphabetic";
  c.fillStyle = accent; c.font = font(650, 17); (c as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "3px"; c.fillText("FORM", 72, 196);
  (c as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";
  c.fillStyle = "#f6f6f6"; let size = 68; c.font = font(560, size);
  let titleLines = wrap(c, form.title, 1040, 2);
  if (titleLines.length > 1 && c.measureText(form.title).width > 1040 * 1.6) { size = 56; c.font = font(560, size); titleLines = wrap(c, form.title, 1040, 2); }
  let y = 196 + 26 + size;
  for (const line of titleLines) { c.fillText(line, 70, y); y += size * 1.06; }
  if (form.description.trim()) {
    c.fillStyle = "#bdbdbd"; c.font = font(400, 27);
    y += 10;
    for (const line of wrap(c, form.description, 1000, titleLines.length > 1 ? 2 : 3)) { c.fillText(line, 72, y); y += 39; }
  }
  // Footer: call to action and address
  c.font = font(600, 24); const label = "Fill the form  →", pad = 26, w = c.measureText(label).width + pad * 2;
  c.fillStyle = accent; c.beginPath(); c.roundRect(72, 520, w, 58, 29); c.fill();
  c.fillStyle = "#17130a"; c.textBaseline = "middle"; c.fillText(label, 72 + pad, 549);
  c.fillStyle = "#8d8d8d"; c.font = font(450, 22); c.textAlign = "right"; c.fillText(`${window.location.host}/f/${form.slug}`, SHARE_W - 72, 549);
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("Couldn't draw the picture."))), "image/jpeg", 0.9));
}

/** Any picture, cropped to fill 1200×630 and saved as JPEG, so uploads stay small. */
export async function fitShareImage(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    if (!image) throw new Error("That file isn't an image this browser can read.");
    const canvas = document.createElement("canvas"); canvas.width = SHARE_W; canvas.height = SHARE_H;
    const c = canvas.getContext("2d")!, scale = Math.max(SHARE_W / image.naturalWidth, SHARE_H / image.naturalHeight);
    const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    c.fillStyle = "#000"; c.fillRect(0, 0, SHARE_W, SHARE_H); c.drawImage(image, (SHARE_W - w) / 2, (SHARE_H - h) / 2, w, h);
    for (const quality of [0.9, 0.8, 0.7, 0.6]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= 690 * 1024) return blob;
    }
    throw new Error("The picture is too detailed to fit. Try a simpler image.");
  } finally { URL.revokeObjectURL(url); }
}

const base64 = async (blob: Blob) => { const bytes = new Uint8Array(await blob.arrayBuffer()); let text = ""; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
export interface ShareImageInfo { auto: boolean; updatedAt: number }
export const uploadShareImage = async (formId: string, blob: Blob, auto: boolean) => (await call<{ shareImage: ShareImageInfo | null }>(`/admin/forms/${formId}/share-image`, { method: "PUT", body: { data: await base64(blob), auto } })).shareImage;

/** Keep the generated picture in step with the form. A picture someone uploaded is never replaced. */
export async function refreshAutoShareImage(form: AdminForm, current: ShareImageInfo | null | undefined): Promise<ShareImageInfo | null> {
  if (current && !current.auto) return current;
  try { return await uploadShareImage(form.id, await drawShareCard(form), true); } catch { return current ?? null; }
}
