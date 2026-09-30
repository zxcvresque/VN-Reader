/** Three-way merge preserves unrelated edits and exposes competing edits, including deletions. */
export function mergeDocuments<T>(base: T, local: T, remote: T): { data: T; conflicts: string[] } {
  const conflicts: string[] = [];
  const equal = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
    if (record(a) && record(b)) { const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k])); }
    return false;
  };
  function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
  const merge = (b: unknown, l: unknown, r: unknown, path: string): unknown => {
    if (equal(l, b)) return r;
    if (equal(r, b) || equal(l, r)) return l;
    if (record(b) && record(l) && record(r)) {
      return Object.fromEntries([...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].flatMap(key => {
        const value = merge(b[key], l[key], r[key], path ? `${path}.${key}` : key);
        return value === undefined ? [] : [[key, value]];
      }));
    }
    conflicts.push(path); return l;
  };
  return { data: merge(base, local, remote, "") as T, conflicts };
}
