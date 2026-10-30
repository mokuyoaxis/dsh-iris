import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual CLI integration wait with independent clock inputs. No
// child process, system clock, provider or daily service is changed by this test.
const source = fs.readFileSync(new URL('./local-api-cli.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function ready(entry) {'), end = source.indexOf('async function stop(entry) {');
assert(start >= 0 && end > start);
const code = source.slice(start, end) + '\nready';
function fixture(clock = performance) {
  let wallReads = 0;
  const logs = [], context = {
    Date: { now: () => wallReads++ ? 60000 : 0 }, performance: clock, Buffer, setTimeout,
    snapshotLintProcesses: () => ({ supported: false, reason: 'controlled fixture', processes: [] }),
    console: { error: value => logs.push(value) }
  };
  return { wait: vm.runInNewContext(code, context), logs };
}
const entry = stdout => ({ stdout, stderr: '', exited: false, child: { pid: 0 }, mode: 'fixture', features: [] });
assert.equal((await fixture().wait(entry('{"ready":true}\n'))).ready, true,
  'a wall-clock jump cannot expire a ready startup response');
const pending = entry('');
setTimeout(() => { pending.stdout = '{"ready":true}\n'; }, 5);
assert.equal((await fixture().wait(pending)).ready, true, 'pending startup still follows the real monotonic clock');
let reads = 0;
const expired = fixture({ now: () => reads++ ? 20001 : 0 });
await assert.rejects(expired.wait(entry('')), /API CLI startup timeout/);
assert.equal(expired.logs.length, 1);
assert.equal(JSON.parse(expired.logs[0].slice('API_CLI_STARTUP_TIMEOUT '.length)).elapsedMs, 20001,
  'the original twenty-second budget remains enforced');
await assert.rejects(fixture().wait({ ...entry(''), exited: true, stderr: 'controlled early exit' }), /exited before startup/);
await assert.rejects(fixture().wait(entry('invalid JSON\n')), error => error.name === 'SyntaxError');
console.log('PASS CLI startup wait: wall-clock changes cannot manufacture a timeout; monotonic deadline, pending response, early exit and malformed JSON remain enforced');
