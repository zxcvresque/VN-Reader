/** Read recorded dimensions without guessing a placeholder shape. */
export function mediaDimensions(raw: unknown, depth = 0): { width: number; height: number } | null {
  if (depth > 6 || !raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const width = Number(item.width ?? item.w), height = Number(item.height ?? item.h);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height };
  // Legacy Telegram exports store photo sizes or document attributes in the TL object.
  const candidates = [item.photo, item.document, item.webpage, ...(Array.isArray(item.sizes) ? item.sizes : []), ...(Array.isArray(item.attributes) ? item.attributes : [])];
  return candidates.map(value => mediaDimensions(value, depth + 1)).filter((value): value is { width: number; height: number } => !!value)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
}
