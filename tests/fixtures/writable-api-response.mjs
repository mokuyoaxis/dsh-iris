import { Writable } from 'node:stream';

/** The real DSH media route pipes to a Node HTTP Writable, including destroy/finish. */
export function writableApiResponse() {
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    final(callback) { this.body = chunks.length ? Buffer.concat(chunks) : undefined; callback(); }
  });
  return Object.assign(output, { headersSent: false, status: 0, headers: {}, body: undefined,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; }
  });
}
