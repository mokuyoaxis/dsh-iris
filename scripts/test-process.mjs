import { spawn, spawnSync } from 'node:child_process';

function reportNativeShutdown(pid) {
  if (!process.env.GITHUB_ACTIONS || process.platform !== 'linux' || !pid) return;
  const available = spawnSync('gdb', ['--version'], { stdio: 'ignore', timeout: 3000 });
  if (available.status !== 0) return;
  console.error(`Native shutdown diagnostic for test process ${pid}:`);
  // Hosted Linux runners provide passwordless sudo; inspect only this test's
  // process. No packages are installed and no ptrace/security policy is changed.
  spawnSync('sudo', ['-n', 'gdb', '--batch', '--quiet',
    '-ex', 'set pagination off', '-ex', 'thread apply all bt', '-ex', 'detach',
    '-p', String(pid)], { stdio: 'inherit', timeout: 10000 });
}

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
      reportNativeShutdown(child.pid);
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
