import fs from 'node:fs';
import path from 'node:path';
import { createCoreRuntime } from '../../lib/core-runtime.js';
import { planCoreDeletion, quarantineCoreFiles, restoreCoreTransaction } from '../../lib/core-maintenance.js';

const [root, artifactId, gate, mode, transactionId] = process.argv.slice(2);
const runtime = createCoreRuntime({ dataRoot: root, mode: 'writer' }); runtime.start();
const rename = fs.renameSync; let paused = false;
fs.renameSync = function(from, to) {
  const result = rename(from, to);
  const moving = mode === 'delete'
    ? String(from).includes(path.sep + path.join('artifact-store', 'v0', 'records') + path.sep) && String(to).includes(path.sep + 'quarantine' + path.sep)
    : String(to).includes(path.sep + path.join('artifact-store', 'v0', 'records') + path.sep) && String(from).includes(path.sep + 'quarantine' + path.sep);
  if (moving && !paused) {
    paused = true; fs.writeSync(1, 'PAUSED\n');
    const wait = new Int32Array(new SharedArrayBuffer(4)), deadline = performance.now() + 15000;
    while (!fs.existsSync(gate)) {
      if (performance.now() > deadline) throw Error('fixture checkpoint timed out');
      Atomics.wait(wait, 0, 0, 20);
    }
  }
  return result;
};
try {
  const value = await runtime.run('execute', ({ dataRoot }) => mode === 'delete'
    ? quarantineCoreFiles(dataRoot, planCoreDeletion(dataRoot, { artifact_ids: [artifactId] }))
    : restoreCoreTransaction(dataRoot, transactionId));
  fs.writeSync(1, JSON.stringify(value) + '\n');
} finally { fs.renameSync = rename; await runtime.dispose(); }
