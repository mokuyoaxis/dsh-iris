import { spawn } from 'node:child_process';

export function testProcessArgs(testFile) {
  return [
    '--import', new URL('./test-shutdown.mjs', import.meta.url).href,
    testFile
  ];
}

// Await the OS close notification with a live parent event loop. Successful
// assertions or JS exit handlers alone do not count as a successful process.
export function runTestProcess(testFile, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, testProcessArgs(testFile), {
      cwd, stdio: 'inherit', shell: false,
      env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '' }
    });
    console.log(`Test process: ${child.pid}`);
    let error;
    const timer = setTimeout(() => {
      error = Object.assign(new Error(`Test process ${child.pid} timed out`), { code: 'ETIMEDOUT' });
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (cause) => { error ??= cause; });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      console.log(`Test process ${child.pid}: closed (${status ?? signal})`);
      resolve({ status, signal, error });
    });
  });
}
