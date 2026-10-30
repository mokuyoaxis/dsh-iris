import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBusinessEnvironment } from './fixtures/plugin-business-consumer.mjs';

const checks = [];
if (process.platform === 'win32') console.log('Plugin SIGKILL recovery requires POSIX; not validated on Windows');
else for (const checkpoint of ['before-read', 'after-import']) {
  const env = await createBusinessEnvironment(), key = crypto.randomUUID();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/plugin-business-crash-child.mjs', import.meta.url)), env.dataRoot, checkpoint, key, JSON.stringify(env.sources)],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let closed = false, output = '', accepted, reached;
  child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const exit = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  child.on('message', value => { if (value.accepted) accepted = value.accepted; if (value.checkpoint === checkpoint) reached = true; });
  try {
    const deadline = Date.now() + 15000;
    while ((!accepted || !reached) && !closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(accepted && reached, checkpoint + ': checkpoint not reached: ' + output);
    await assert.rejects(env.cliRun('execution', 'recover-lease', '--confirm-stale-pid', String(child.pid)));
    child.kill('SIGKILL'); assert.equal((await exit).signal, 'SIGKILL');
    const stale = await env.cliRun('execution', 'inspect'); assert.equal(stale.ownerStatus, 'missing');
    await env.cliRun('execution', 'recover-lease', '--confirm-stale-pid', String(child.pid));
    await env.cliRun('runtime', 'recover', '--confirm-stale-pid', String(child.pid));
    await env.start({ present: false });
    const saved = (await env.http('/api/v0/operations?key=' + key)).operation;
    assert.equal(saved.id, accepted); assert.equal(saved.state, 'interrupted'); assert.equal(saved.result.value, null);
    assert.equal(saved.result.artifactIds.length, checkpoint === 'after-import' ? 1 : 0);
    if (saved.result.artifactIds.length) assert.equal((await env.raw('/api/v0/artifacts/' + saved.result.artifactIds[0] + '/content')).status, 200);
    await env.close(); await env.start();
    assert.equal((await env.submit({ key, operationId: saved.operationId, dependency: saved.dependency, input: saved.input })).operation.state, 'interrupted');
    assert.equal((await env.http('/api/v0/plugin-operations/catalog')).artifacts.length, checkpoint === 'after-import' ? 3 : 2);
    checks.push(checkpoint + ': real child SIGKILL, explicit dead-PID lease recovery, plugin-free startup, original UUID/partial output retained, no replay');
  } finally { if (!closed) { child.kill('SIGKILL'); await exit; } await env.close(); }
}
console.log(JSON.stringify({ ok: true, checks }, null, 2));
