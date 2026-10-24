import { createManagedConnectionStore } from '../../lib/core-connection-store.js';
import { inspectExecutionRoot } from '../../lib/operation-store.js';
const [dataRoot, directory, key] = process.argv.slice(2);
const store = createManagedConnectionStore({ dataRoot, directory, rootId: inspectExecutionRoot(dataRoot).rootId,
  getOrigin: () => 'http://127.0.0.1:3210' });
await store.start(); store.create({ key, label: 'Committed before forced stop', scopes: ['read'], capabilities: [] });
store.revoke(key, { expectedRevision: 1 });
process.send({ ready: true, key });
setInterval(() => {}, 1000);
