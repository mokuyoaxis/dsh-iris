import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLocalReadApi } from '../../lib/local-api.js';

const [stage, dataRoot, outboxDir, key, artifactId, name] = process.argv.slice(2);
const api = createLocalReadApi({ dataRoot, outboxDir, allowLocalWrites: true });
function checkpoint() {
  fs.writeSync(1, 'CHECKPOINT ' + stage + '\n');
  process.kill(process.pid, 'SIGKILL');
}

if (stage === 'copy') {
  const open = fs.promises.open;
  fs.promises.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (typeof file === 'string' && path.dirname(file) === outboxDir && path.basename(file).startsWith('.iris-outbox-')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...input) => {
        await write(...input);
        const stat = await handle.stat();
        assert(stat.size > 0 && stat.size < 1024 * 1024);
        checkpoint();
      };
    }
    return handle;
  };
} else {
  const link = fs.linkSync;
  fs.linkSync = (source, target) => {
    link(source, target);
    if (target === path.join(outboxDir, name)) checkpoint();
  };
}

const session = await api.start();
try {
  const response = await fetch(session.origin + '/api/v0/outbox/export', {
    method: 'POST', headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ artifactId, name })
  });
  assert.fail('Core unexpectedly returned ' + response.status + ' ' + await response.text());
} finally {
  await api.dispose();
}
