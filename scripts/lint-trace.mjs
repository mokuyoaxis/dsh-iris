import fs from 'node:fs';
import path from 'node:path';

/** One private log per run; never replace or rotate earlier failure evidence. */
export function createLintTrace(root) {
  const base = path.join(root, '.internal', 'lint-traces');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(base, 'run-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  return file;
}

/** Synchronous append survives SIGKILL without relying on JS exit handlers. */
export function recordLintTrace(file, event, details = {}) {
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details }) + '\n', { mode: 0o600 });
}

function readProc(file) {
  try { return { text: fs.readFileSync(file, 'utf8').trim() }; }
  catch (error) {
    // A process can exit during collection; inaccessible proc data is explicit.
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return { unavailable: error.code };
    throw error;
  }
}

/** Select this tree by proc parent PIDs; Android may lack proc children files. */
export function snapshotLintProcesses(rootPid) {
  if (process.platform !== 'linux') return { supported: false, reason: 'linux-proc-only', processes: [] };
  const stats = new Map();
  const children = new Map();
  // Read relationship metadata only; no cmdline, environ, or unrelated wchan.
  for (const name of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    const pid = Number(name);
    const stat = readProc(`/proc/${pid}/stat`);
    if (stat.unavailable) continue;
    const end = stat.text.lastIndexOf(')');
    const fields = stat.text.slice(end + 2).split(/\s+/);
    const parentPid = Number(fields[1]);
    stats.set(pid, { pid, name: stat.text.slice(stat.text.indexOf('(') + 1, end), state: fields[0], parentPid,
      userTicks: Number(fields[11]), systemTicks: Number(fields[12]), threads: Number(fields[17]), startTicks: Number(fields[19]) });
    if (!children.has(parentPid)) children.set(parentPid, []);
    children.get(parentPid).push(pid);
  }
  const processes = [];
  const pending = [rootPid];
  while (pending.length) {
    const pid = pending.shift();
    const stat = stats.get(pid);
    if (!stat) { processes.push({ pid, unavailable: 'not-observed' }); continue; }
    const wchan = readProc(`/proc/${pid}/wchan`);
    const childPids = children.get(pid) || [];
    processes.push({ ...stat,
      ...(wchan.unavailable ? { waitChannelUnavailable: wchan.unavailable } : { waitChannel: wchan.text }),
      childPids });
    pending.push(...childPids);
  }
  return { supported: true, discovery: 'proc-parent-pids', processes };
}
