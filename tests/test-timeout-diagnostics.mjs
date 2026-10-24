import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTestProcess } from '../scripts/test-process.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-test-timeout'), waiting = path.join(root, 'waiting.mjs');
fs.writeFileSync(waiting, 'setInterval(() => {}, 1000);\n');
const original = console.error, errors = [];
let result;
try {
  console.error = (...items) => errors.push(items.join(' '));
  result = await runTestProcess(waiting, { cwd: root, timeoutMs: 150 });
} finally { console.error = original; }
assert.equal(result.error.code, 'ETIMEDOUT'); assert.equal(result.signal, 'SIGKILL');
assert.equal(errors.filter(line => line.startsWith('TEST_TIMEOUT_CONTEXT ')).length, 1);
const context = JSON.parse(errors.find(line => line.startsWith('TEST_TIMEOUT_CONTEXT ')).slice('TEST_TIMEOUT_CONTEXT '.length));
assert.equal(context.testFile, 'waiting.mjs'); assert.equal(context.timeoutMs, 150); assert(Number.isInteger(context.childPid));
assert(context.elapsedMs >= 150); assert(Array.isArray(context.processSnapshot.processes));
assert(!JSON.stringify(context).includes('cmdline')); assert(!JSON.stringify(context).includes('environ'));
console.log('Test timeout: original deadline retained, structured process context emitted and OS close awaited');
