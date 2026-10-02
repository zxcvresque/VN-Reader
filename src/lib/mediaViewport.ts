export interface MediaSize { width: number; height: number }
export interface MediaTransform { scale: number; x: number; y: number }
export const FIT_TRANSFORM: MediaTransform = { scale: 1, x: 0, y: 0 };
export const MAX_MEDIA_ZOOM = 8;

export function fitMedia(natural: MediaSize, viewport: MediaSize): MediaSize {
  if (!natural.width || !natural.height || !viewport.width || !viewport.height) return { width: 0, height: 0 };
  const ratio = Math.min(viewport.width / natural.width, viewport.height / natural.height, 1);
  return { width: natural.width * ratio, height: natural.height * ratio };
}

export function constrainMedia(transform: MediaTransform, fitted: MediaSize, viewport: MediaSize): MediaTransform {
  const scale = Math.max(1, Math.min(MAX_MEDIA_ZOOM, transform.scale));
  const maxX = Math.max(0, (fitted.width * scale - viewport.width) / 2);
  const maxY = Math.max(0, (fitted.height * scale - viewport.height) / 2);
  return { scale, x: Math.max(-maxX, Math.min(maxX, transform.x)), y: Math.max(-maxY, Math.min(maxY, transform.y)) };
}

export function zoomMediaAt(current: MediaTransform, scale: number, point: { x: number; y: number }, fitted: MediaSize, viewport: MediaSize): MediaTransform {
  const nextScale = Math.max(1, Math.min(MAX_MEDIA_ZOOM, scale));
  const ratio = nextScale / current.scale;
  return constrainMedia({ scale: nextScale, x: point.x - (point.x - current.x) * ratio, y: point.y - (point.y - current.y) * ratio }, fitted, viewport);
}
