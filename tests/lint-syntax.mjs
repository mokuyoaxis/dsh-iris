import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { startSyntaxCheck } from '../scripts/lint-syntax.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-lint-syntax');
const valid = path.join(root, 'valid module 中文.mjs'), marker = path.join(root, 'must-not-execute');
fs.writeFileSync(valid, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');throw Error('must not execute');\n`);
const good = startSyntaxCheck(valid);
assert(Number.isInteger(good.pid)); assert.equal((await good.completion).status, 0);
assert.equal(fs.existsSync(marker), false, 'syntax checks must not execute module code');
const invalid = path.join(root, 'invalid.mjs'); fs.writeFileSync(invalid, 'export const broken = ;\n');
const bad = await startSyntaxCheck(invalid).completion;
assert.equal(bad.status, 1); assert.match(bad.stderr, /SyntaxError/); assert.equal(bad.timedOut, false);

let parentTimerRan = false, launch;
const timer = setTimeout(() => { parentTimerRan = true; }, 50);
const stalled = startSyntaxCheck(valid, { timeoutMs: 350, execute(program, args, options, done) {
  launch = { program, args, options };
  return execFile(program, ['--eval', 'setInterval(()=>{},1000)'], options, done);
} });
const timedOut = await stalled.completion; clearTimeout(timer);
assert.equal(parentTimerRan, true, 'waiting for the parser must not block lint timers');
assert.deepEqual(launch.args, ['--check', valid]); assert.equal(launch.options.shell, false);
assert.equal(timedOut.timedOut, true); assert.equal(timedOut.errorCode, 'ETIMEDOUT');
assert.equal(timedOut.signal, 'SIGKILL'); assert.equal(timedOut.status, null);
assert.throws(() => process.kill(stalled.pid, 0), { code: 'ESRCH' }, 'completion requires an OS-reaped child');

const missing = await startSyntaxCheck(valid, { execute(_program, _args, options, done) {
  return execFile(path.join(root, 'missing-node'), [], options, done);
} }).completion;
assert.equal(missing.errorCode, 'ENOENT'); assert.equal(missing.timedOut, false);
const overflow = await startSyntaxCheck(valid, { execute(program, _args, options, done) {
  return execFile(program, ['--eval', 'process.stdout.write("x".repeat(2*1024*1024))'], options, done);
} }).completion;
assert.equal(overflow.errorCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'); assert.equal(overflow.timedOut, false);
console.log('PASS async syntax checks: real Node parsing without execution, literal paths, syntax errors, responsive parent, bounded SIGKILL/OS close, startup failure and output limit');
