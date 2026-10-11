import fs from 'node:fs';
import path from 'node:path';
import { createCoreRuntime } from '../../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../../lib/core-lease-recovery.js';

const [stage, root, pid] = process.argv.slice(2);
const directory = path.join(root, '.iris-runtime-writer-v0');
const intent = path.join(root, '.iris-runtime-writer-v0.owner.json');
function checkpoint(hit) {
  if (!hit) return;
  if (stage === 'recovery-hold') {
    fs.writeSync(1, 'READY\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  fs.writeSync(1, 'CHECKPOINT ' + stage + '\n');
  process.kill(process.pid, 'SIGKILL');
}
for (const method of ['writeFileSync', 'mkdirSync', 'linkSync', 'renameSync', 'unlinkSync']) {
  const original = fs[method];
  fs[method] = (...args) => {
    const result = original(...args);
    const first = String(args[0]), second = String(args[1]);
    checkpoint((stage === 'prepare-written' && method === 'writeFileSync' && first.includes('.owner.json.prepare-'))
      || (stage === 'intent-published' && method === 'linkSync' && second === intent)
      || (stage === 'directory-created' && method === 'mkdirSync' && first === directory)
      || (stage === 'owner-published' && method === 'linkSync' && second === path.join(directory, 'owner.json'))
      || (stage === 'release-retired' && method === 'renameSync' && first === directory && second.includes('.released-'))
      || (stage === 'release-intent-removed' && method === 'unlinkSync' && first === intent)
      || (stage === 'release-owner-removed' && method === 'unlinkSync' && first.includes('.released-') && first.endsWith('/owner.json'))
      || (['recovery-claim-published', 'recovery-hold'].includes(stage) && method === 'linkSync' && second.includes('.iris-runtime-writer-v0.recovery-'))
      || (stage === 'recovery-audit-published' && method === 'linkSync' && /lease_recovery_[a-f0-9]+\.json$/.test(second))
      || (stage === 'recovery-retired' && method === 'renameSync' && first === directory && second.endsWith('.lease'))
      || (stage === 'recovery-intent-removed' && method === 'unlinkSync' && first === intent));
    return result;
  };
}
if (stage.startsWith('recovery-')) recoverCoreWriterLease(root, { confirmStalePid: Number(pid) });
else {
  const runtime = createCoreRuntime({ dataRoot: root, mode: 'writer' });
  runtime.start();
  if (stage.startsWith('release-')) await runtime.dispose();
}
throw new Error('crash checkpoint was not reached: ' + stage);
