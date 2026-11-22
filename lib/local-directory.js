import fs from 'node:fs';
import path from 'node:path';

export function resolveMaybeMissing(target) {
  try { return fs.realpathSync.native(target); } catch (_) { /* Resolve the nearest existing ancestor. */ }
  const parts = [];
  let cursor = path.resolve(target);
  while (true) {
    try { return path.join(fs.realpathSync.native(cursor), ...parts.reverse()); }
    catch (_) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(target);
      parts.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function pathsOverlap(a, b) {
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  return contains(a, b) || contains(b, a);
}
