import { createCoreRuntime } from '../../lib/core-runtime.js';

const runtime = createCoreRuntime({ dataRoot: process.argv[2], mode: 'writer' });
runtime.start();
process.stdout.write('READY\n');

process.stdin.resume();
process.stdin.once('data', async () => {
  try {
    await runtime.dispose();
    process.exit(0);
  } catch (error) {
    process.stderr.write(String(error && error.stack || error));
    process.exit(1);
  }
});
