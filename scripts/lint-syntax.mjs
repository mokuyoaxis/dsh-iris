import { execFile } from 'node:child_process';

// Keep lint responsive while Node parses one file. The outer test deadline is unchanged.
export function startSyntaxCheck(file, { timeoutMs = 30000, execute = execFile } = {}) {
  let child;
  const completion = new Promise(resolve => {
    child = execute(process.execPath, ['--check', file], {
      encoding: 'utf8', shell: false, windowsHide: true,
      timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      const timedOut = Boolean(error?.killed && error.signal === 'SIGKILL' && error.code === null);
      resolve({ pid: child.pid, status: error ? typeof error.code === 'number' ? error.code : null : 0,
        signal: error?.signal ?? null, stdout, stderr, timedOut,
        ...(error ? { message: error.message } : {}),
        ...(timedOut ? { errorCode: 'ETIMEDOUT' } : typeof error?.code === 'string' ? { errorCode: error.code } : {}) });
    });
  });
  return { pid: child.pid, completion };
}
