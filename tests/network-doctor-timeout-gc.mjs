import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/network-doctor-gc-fixture.mjs', import.meta.url));
const child = spawn(process.execPath, ['--expose-gc', fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', timedOut = false;
child.stdout.on('data', bytes => { output += bytes; });
child.stderr.on('data', bytes => { output += bytes; });
const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20000);
try {
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(timedOut, false, 'Doctor must retain its 8-second deadline through GC:\n' + output);
  assert.equal(result.code, 0, JSON.stringify(result) + '\n' + output);
  assert(output.includes('"phase":"complete"'), output);
  assert(output.includes('8-second timeout, cancellation'), output);
  console.log('PASS actual HTTP/HTTPS Doctor timeout and cancellation with forced GC on ' + process.version);
} finally { clearTimeout(deadline); }
