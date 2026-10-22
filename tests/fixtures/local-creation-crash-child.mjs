import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './image-flow-fixture.mjs';

const [stage, suppliedRoot, inputFile] = process.argv.slice(2);
const root = fs.realpathSync.native(suppliedRoot);
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
function crash(hit) {
  if (!hit) return;
  fs.writeSync(1, 'CHECKPOINT ' + stage + '\n'); process.kill(process.pid, 'SIGKILL');
}
for (const method of ['linkSync', 'renameSync']) {
  const original = fs[method];
  fs[method] = (...args) => {
    const destination = String(args[1]);
    const request = path.dirname(destination) === path.join(root, 'creation-requests/v0/requests');
    const rootMarker = destination === path.join(root, 'creation-requests/v0/root.json');
    crash(method === 'linkSync' && ((stage.endsWith('intent-before') && request) || (stage === 'init-before' && rootMarker)));
    const result = original(...args);
    const saved = request ? JSON.parse(fs.readFileSync(destination, 'utf8')) : null;
    crash((stage.endsWith('intent') && request && saved.state === 'prepared')
      || (stage.endsWith('success') && request && saved.state === 'succeeded')
      || (stage === 'image-object' && path.dirname(destination) === path.join(root, 'artifact-store/v0/objects'))
      || (stage === 'image-manifest' && path.dirname(destination) === path.join(root, 'artifact-store/v0/manifests'))
      || (stage === 'image-record' && path.dirname(destination) === path.join(root, 'artifact-store/v0/records'))
      || (['flow-run', 'flow-run-advanced'].includes(stage) && path.dirname(destination) === path.join(root, 'flow-store/v0/runs'))
      || (stage === 'init-after' && rootMarker));
    return result;
  };
}
const app = createApplicationRuntime({ dataRoot: root, ...imageFlowFixture(root) });
await app.execute(stage.startsWith('init-') ? 'creation.init' : stage.startsWith('image-') ? 'creation.image' : 'creation.flow',
  stage.startsWith('image-') ? { key: input.key, bytes: FLOW_SOURCE, mediaType: 'image/png' }
    : stage.startsWith('flow-') ? { key: input.key, value: { sourceArtifactId: input.sourceId, modelRef: FLOW_MODEL, prompt: 'Crash-safe local creation' } } : {});
await app.dispose();
throw new Error('Creation checkpoint not reached: ' + stage);
