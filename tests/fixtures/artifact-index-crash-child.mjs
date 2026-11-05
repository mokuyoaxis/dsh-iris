import fs from 'node:fs';
import path from 'node:path';
import { createCoreArtifact } from '../../lib/core-artifacts.js';

const root = process.argv[2], rename = fs.renameSync;
fs.renameSync = (source, target) => {
  if (target === path.join(root, 'artifact-store/v0/index.json')) {
    fs.writeSync(1, 'CHECKPOINT record-before-index\n');
    process.kill(process.pid, 'SIGKILL');
  }
  return rename(source, target);
};
createCoreArtifact(root, { bytes: Buffer.from('isolated interrupted commit'), mediaType: 'image/png', kind: 'fixture' });
throw new Error('fixture did not reach the index publication checkpoint');
