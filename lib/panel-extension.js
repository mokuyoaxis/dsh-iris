import fs from 'node:fs';
import path from 'node:path';

export const PANEL_CONTRACT_VERSION = 0;
const TYPES = new Map([['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.woff2', 'font/woff2']]);
const fail = () => { throw Object.assign(new TypeError('Panel 清单、版本或固定资源无效'), { code: 'IRIS_PANEL_INVALID' }); };

/** Explicit trusted static Panel. Pin its finite assets before exposing any public route. */
export function loadPanelExtension(manifestPath) {
  if (typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath)) fail();
  const file = fs.realpathSync(manifestPath), root = path.dirname(file);
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 65536) fail();
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { fail(); }
  if (!manifest || manifest.contractVersion !== PANEL_CONTRACT_VERSION || !/^[a-z][a-z0-9._-]{0,79}$/.test(manifest.id)
    || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)
    || Object.keys(manifest).some(key => !['contractVersion', 'id', 'version', 'assets'].includes(key))
    || !manifest.assets || typeof manifest.assets !== 'object' || Array.isArray(manifest.assets)) fail();
  const entries = Object.entries(manifest.assets), assets = new Map();
  if (!entries.length || entries.length > 128 || !Object.hasOwn(manifest.assets, '/')) fail();
  let total = 0;
  for (const [route, relative] of entries) {
    if (route !== '/' && (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(route)
      || route.startsWith('/api/') || route === '/mcp' || route.startsWith('/mcp/'))
      || typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) fail();
    const target = fs.realpathSync(path.resolve(root, relative)), rel = path.relative(root, target), stat = fs.statSync(target);
    const mediaType = TYPES.get(path.extname(target));
    if (!rel || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || !stat.isFile() || !mediaType
      || stat.size > 8 * 1024 * 1024 || (total += stat.size) > 16 * 1024 * 1024 || route === '/' && path.extname(target) !== '.html') fail();
    assets.set(route, { bytes: fs.readFileSync(target), mediaType });
  }
  return Object.freeze({ identity: Object.freeze({ contractVersion: PANEL_CONTRACT_VERSION, id: manifest.id, version: manifest.version }),
    has: route => assets.has(route), read: async route => assets.get(route) || null });
}
