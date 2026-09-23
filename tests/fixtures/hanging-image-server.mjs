// RECONSTRUCTED 2026-09-23 from the T-17 signal lease test specification.
// Loopback-only Provider fixture: accepts an image request and never answers it.
import fs from 'node:fs';
import http from 'node:http';

const requestFile = process.argv[2];
const closedFile = process.argv[3];
if (!requestFile || !closedFile) throw new Error('request and close marker paths required');

const server = http.createServer((request, response) => {
  fs.writeFileSync(requestFile, JSON.stringify({ method: request.method, url: request.url }), { mode: 0o600 });
  response.on('close', () => {
    if (!response.writableEnded) fs.writeFileSync(closedFile, 'closed\n', { mode: 0o600 });
  });
  request.resume();
});

server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\n'));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
