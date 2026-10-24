// Runner ownership uses the existing Core lease protocol in its own private directory.
import fs from 'node:fs';
import path from 'node:path';
import { readWriterLease, WRITER_LEASE_DIR, WRITER_INTENT_FILE } from './core-writer-lease.js';

const UUID = '[a-f0-9-]{36}';
const FILE = new RegExp('^(?:' + WRITER_INTENT_FILE.replaceAll('.', '\\.')
  + '(?:\\.prepare-[1-9][0-9]*-[a-f0-9]{12})?|' + WRITER_LEASE_DIR.replaceAll('.', '\\.')
  + '\\.recovery-' + UUID + '\\.json)$');
const RETIRED = new RegExp('^' + WRITER_LEASE_DIR.replaceAll('.', '\\.') + '\\.released-' + UUID + '$');
const invalid = () => { throw Object.assign(new Error('执行所有权目录未知或损坏；已保留现场'), { code: 'IRIS_EXECUTION_LEASE_INVALID' }); };

export function inspectRunnerArea(directory) {
  function regular(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) invalid();
  }
  function ownerDirectory(file, audit = false) {
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    for (const name of fs.readdirSync(file)) {
      if (name !== 'owner.json' && !/^\.owner\.stale-[a-f0-9-]{36}\.json$/.test(name)
          && !(audit && new RegExp('^' + WRITER_LEASE_DIR.replaceAll('.', '\\.') + '\\.recovery-' + UUID + '\\.json$').test(name))) invalid();
      regular(path.join(file, name));
    }
  }
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (name === WRITER_LEASE_DIR || RETIRED.test(name)) ownerDirectory(file);
    else if (FILE.test(name)) regular(file);
    else if (name === '.iris-runtime-recovery-audit-v0') {
      const stat = fs.lstatSync(file);
      if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
      for (const entry of fs.readdirSync(file)) {
        if (/^lease_recovery_[a-f0-9]{24}\.json$/.test(entry)) regular(path.join(file, entry));
        else if (/^lease_recovery_[a-f0-9]{24}\.lease$/.test(entry)) ownerDirectory(path.join(file, entry), true);
        else invalid();
      }
    } else invalid();
  }
  try { return readWriterLease(directory); }
  catch (_) { invalid(); }
}
