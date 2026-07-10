const mediaUrlCache = new Map<string, string>();

async function openRelativeFile(
  directoryHandle: FileSystemDirectoryHandle,
  relativePath: string
): Promise<File> {
  // Archive paths come from a Python exporter on Windows so they may use
  // either '/' or '\' as separators. Split on both.
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  let currentDirectory = directoryHandle;

  for (const part of parts.slice(0, -1)) {
    currentDirectory = await currentDirectory.getDirectoryHandle(part);
  }

  const fileHandle = await currentDirectory.getFileHandle(parts.at(-1)!);
  return fileHandle.getFile();
}

export async function getMediaObjectUrl(
  directoryHandle: FileSystemDirectoryHandle,
  relativePath: string,
  cacheKey: string
): Promise<string> {
  const cached = mediaUrlCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const file = await openRelativeFile(directoryHandle, relativePath);
  const objectUrl = URL.createObjectURL(file);
  mediaUrlCache.set(cacheKey, objectUrl);
  return objectUrl;
}

export function revokeAllMediaObjectUrls(): void {
  mediaUrlCache.forEach((url) => URL.revokeObjectURL(url));
  mediaUrlCache.clear();
}
