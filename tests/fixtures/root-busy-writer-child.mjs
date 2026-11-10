import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCoreRuntime } from '../../lib/core-runtime.js';

const [dataRoot, directory] = process.argv.slice(2);
let runtime;
const publish = value => {
  const target = path.join(directory, 'held.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(target + '.tmp', target);
};
try {
  fs.writeFileSync(path.join(directory, 'prepared'), '', { mode: 0o600 });
  const deadline = performance.now() + 90000;
  while (!fs.existsSync(path.join(directory, 'release'))) {
    if (performance.now() >= deadline) throw new Error('root-busy fixture release deadline');
    if (!runtime && fs.existsSync(path.join(directory, 'acquire'))) {
      runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
      runtime.start(); publish({ pid: process.pid });
    }
    await delay(10);
  }
} catch (error) {
  publish({ error: error.message }); console.error(error); process.exitCode = 1;
} finally { await runtime?.dispose(); }
