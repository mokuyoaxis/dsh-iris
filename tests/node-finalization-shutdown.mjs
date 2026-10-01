import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Node 22 includes the nodejs/node#51290 fix. Queue a finalizer at the final
// opportunity to execute JS: older runtimes loop while freeing the environment.
const fixture = `
  const registry = new FinalizationRegistry(() => {
    throw new Error('Finalizer must not run after the exit event');
  });
  function register() { registry.register({}); }
  process.once('exit', () => { register(); global.gc(); });
`;
const result = spawnSync(process.execPath, ['--expose-gc', '--eval', fixture], {
  encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL'
});
assert.ifError(result.error);
assert.equal(result.signal, null, result.stderr);
assert.equal(result.status, 0, result.stderr);
console.log('FinalizationRegistry shutdown: child exited naturally');
