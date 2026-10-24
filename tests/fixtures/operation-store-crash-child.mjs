import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';

const [stage, suppliedRoot, inputFile] = process.argv.slice(2), root = fs.realpathSync.native(suppliedRoot);
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const marker = path.join(root, 'creation-requests/v1/root.json'), operations = path.join(root, 'creation-requests/v1/operations');
function crash() { fs.writeSync(1, 'CHECKPOINT ' + stage + '\n'); process.kill(process.pid, 'SIGKILL'); }
for (const method of ['linkSync', 'renameSync']) {
  const original = fs[method];
  fs[method] = (...args) => {
    const destination = String(args[1]);
    const matched = stage.startsWith('init-') ? destination === marker
      : path.dirname(destination) === operations && destination.endsWith('.json');
    if (matched && stage.endsWith('-before')) crash();
    const result = original(...args);
    if (matched && stage.endsWith('-after')) crash();
    return result;
  };
}
const app = createApplicationRuntime({ dataRoot: root });
if (stage.startsWith('init-')) await app.execute('execution.init', {});
else if (stage.startsWith('accept-')) await app.execute('operation.accept', input.accept);
else await app.execute('operation.transition', { id: input.id, expectedRevision: stage.startsWith('finish-') ? 2 : 1,
  state: stage.startsWith('start-') ? 'running' : stage.startsWith('finish-') ? 'succeeded' : 'canceled' });
await app.dispose();
throw new Error('Operation checkpoint not reached: ' + stage);
