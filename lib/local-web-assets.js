import fs from 'node:fs/promises';

// Fixed package resources only. Never resolve a request path against a filesystem directory.
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/transport.js', ['transport.js', 'text/javascript; charset=utf-8']],
  ['/flow-view.js', ['flow-view.js', 'text/javascript; charset=utf-8']],
  ['/connections.js', ['connections.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/iris-mark.svg', ['../../docs/assets/logo/iris-mark.svg', 'image/svg+xml']]
]);
export const LOCAL_WEB_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function readLocalWebAsset(pathname) {
  const entry = ASSETS.get(pathname);
  if (!entry) return null;
  return { bytes: await fs.readFile(new URL('./web/' + entry[0], import.meta.url)), mediaType: entry[1] };
}

export const isLocalWebAsset = pathname => ASSETS.has(pathname);
