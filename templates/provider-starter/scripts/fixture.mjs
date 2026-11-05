// Local-only acceptance service. Never a real DashScope gateway.
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
export async function createFixture() {
  const requests = [], errors = [], tasks = new Set(); let ready = false, mode = 'normal', active = 0, peak = 0, origin, cdnOrigin, submitGate, release;
  const sockets = new Set();
  const track = server => server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const cdn = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, cdn: true });
    if (req.url === '/redirect') { res.writeHead(302, { Location: cdnOrigin + '/image.png' }); res.end(); }
    else { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); }
  }); track(cdn); cdn.listen(0, '127.0.0.1'); await once(cdn, 'listening'); cdnOrigin = `http://127.0.0.1:${cdn.address().port}`;
  async function handle(req, res) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const row = { method: req.method, path: req.url, authorization: req.headers.authorization,
      async: req.headers['x-dashscope-async'], body: Buffer.concat(chunks).toString('utf8'), cdn: false };
    requests.push(row); res.setHeader('Content-Type', 'application/json');
    if (mode === 'redirect') { res.writeHead(302, { Location: cdnOrigin + '/image.png' }); res.end(); return; }
    if (mode === 'rate-limit') { res.writeHead(429, { 'Retry-After': '2' }); res.end('{"error":"synthetic-private-upstream-detail"}'); return; }
    if (mode === 'html') { res.end('<html>synthetic-private-upstream-detail</html>'); return; }
    if (mode === 'large') { res.end('x'.repeat(1024 * 1024 + 1)); return; }
    const url = new URL(req.url, origin);
    if (url.pathname === '/api/v1/models') {
      const page = Number(url.searchParams.get('page_no'));
      const models = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ model: 'unsupported-fixture-' + i })) : [{ model: 'wan2.6-t2i' }];
      res.end(JSON.stringify({ output: { total: mode === 'bad-page' && page === 2 ? 102 : 101,
        page_no: page, page_size: 100, models } })); return;
    }
    if (url.pathname === '/api/v1/services/aigc/image-generation/generation' && req.method === 'POST') {
      active++; peak = Math.max(peak, active); if (submitGate) await submitGate; else await delay(120); active--;
      if (mode === 'reset') { req.socket.destroy(); return; }
      if (mode === 'missing-id') { res.end('{"output":{}}'); return; }
      const id = 'original-remote-' + (tasks.size + 1); tasks.add(id);
      res.end(JSON.stringify({ output: { task_id: id, task_status: 'PENDING' } })); return;
    }
    if (url.pathname.startsWith('/api/v1/tasks/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/v1/tasks/'.length));
      if (!tasks.has(id)) { res.writeHead(404).end('{}'); return; }
      res.end(JSON.stringify({ output: { task_id: id, task_status: ready ? 'SUCCEEDED' : 'RUNNING',
        ...(ready ? { choices: mode === 'bad-poll' ? {} : [{ message: { content: [{ image: cdnOrigin + '/redirect' }] } }] } : {}) } })); return;
    }
    res.writeHead(404).end('{}');
  }
  const server = http.createServer((req, res) => { void handle(req, res).catch(error => { errors.push(error.message); res.destroy(); }); });
  track(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, cdnOrigin, requests, errors, tasks, get peak() { return peak; },
    set mode(value) { mode = value; }, set ready(value) { ready = value; },
    holdSubmits() { submitGate = new Promise(resolve => { release = resolve; }); },
    releaseSubmits() { release?.(); submitGate = undefined; },
    async close() { release?.(); for (const socket of sockets) socket.destroy(); await Promise.all([server, cdn].map(item => new Promise(resolve => item.close(resolve)))); } };
}
