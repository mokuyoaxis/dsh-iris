import fs from 'node:fs/promises';

// Fixed package resources only. Never resolve a request path against a filesystem directory.
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/startup.js', ['startup.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/transport.js', ['transport.js', 'text/javascript; charset=utf-8']],
  ['/workbench-login.js', ['workbench-login.js', 'text/javascript; charset=utf-8']],
  ['/media-client.js', ['media-client.js', 'text/javascript; charset=utf-8']],
  ['/recovery.js', ['recovery.js', 'text/javascript; charset=utf-8']],
  ['/creation.js', ['creation.js', 'text/javascript; charset=utf-8']],
  ['/gallery.js', ['gallery.js', 'text/javascript; charset=utf-8']],
  ['/plugin-panel.js', ['plugin-panel.js', 'text/javascript; charset=utf-8']],
  ['/plugin-surface.css', ['plugin-surface.css', 'text/css; charset=utf-8']],
  ['/flow-view.js', ['flow-view.js', 'text/javascript; charset=utf-8']],
  ['/connections.js', ['connections.js', 'text/javascript; charset=utf-8']],
  ['/providers.js', ['providers.js', 'text/javascript; charset=utf-8']],
  ['/comfyui.js', ['comfyui.js', 'text/javascript; charset=utf-8']],
  ['/appearance.js', ['appearance.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/iris-mark.svg', ['../../docs/assets/logo/iris-mark.svg', 'image/svg+xml']]
]);
export const LOCAL_WEB_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function readLocalWebAsset(pathname) {
  const entry = ASSETS.get(pathname);
  if (!entry) return null;
  return { bytes: await fs.readFile(new URL('./web/' + entry[0], import.meta.url)), mediaType: entry[1] };
}

export const isLocalWebAsset = pathname => ASSETS.has(pathname);

export const DEFAULT_PANEL = Object.freeze({
  identity: Object.freeze({ contractVersion: 0, id: 'iris.default-panel', version: '0.1.0' }),
  has: isLocalWebAsset, read: readLocalWebAsset
});
