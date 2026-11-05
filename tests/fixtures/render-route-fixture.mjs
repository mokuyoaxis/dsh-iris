import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { serveRender } from '../../lib/render.js';

/** Unit browsers deliver through the real route; optional reverse-proxy prefixes are already stripped. */
export function deliverRender(url) {
  const pathname = new URL(url).pathname, offset = pathname.indexOf('/iris/render/');
  assert(offset >= 0);
  const response = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(bytes) { this.bytes = bytes; this.emit('finish'); }
  });
  serveRender({ method: 'GET', url: pathname.slice(offset) }, response);
  assert.equal(response.status, 200);
  return response.bytes;
}
