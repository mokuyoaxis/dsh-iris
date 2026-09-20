'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { normalizeCoreOptions } from './core-contract.js';
import { inspectCoreWriterLease } from './core-runtime.js';
import { listCoreTasks } from './core-tasks.js';
import { inspectCoreArtifactStore } from './core-artifact-store.js';

/** 仅返回计数和状态，不返回 Task 内容、文件名或数据根路径。 */
export function inspectCoreStorage(dataRoot) {
  const options = normalizeCoreOptions({ dataRoot, mode: 'reader' });
  let root;
  try {
    root = fs.realpathSync.native(options.dataRoot);
    if (!fs.statSync(root).isDirectory()) return { status: 'invalid' };
  } catch (error) { return { status: error?.code === 'ENOENT' ? 'absent' : 'invalid' }; }
  const report = { status: 'present', lease: inspectCoreWriterLease(root) };
  try {
    const tasks = listCoreTasks(root, { limit: 1, skipInvalid: true });
    let taskStatus = 'present';
    let unresolved = 0;
    for (const relative of ['task-store', 'task-store/v0', 'task-store/v0/tasks']) {
      try { fs.lstatSync(path.join(root, relative)); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        // Entire store absent is valid for a new root; a partial tree needs diagnosis.
        taskStatus = relative === 'task-store' ? 'absent' : 'invalid';
        break;
      }
    }
    if (taskStatus === 'present') {
      unresolved = fs.readdirSync(path.join(root, 'task-store/v0/tasks'))
        .filter((name) => !/^task_[a-f0-9]{24}\.json$/.test(name)).length;
    }
    report.tasks = { status: taskStatus, total: tasks.total, invalid: tasks.dropped, unresolved };
  } catch (_) { report.tasks = { status: 'invalid' }; }
  try { report.artifacts = inspectCoreArtifactStore(root); }
  catch (_) { report.artifacts = { status: 'invalid' }; }
  return report;
}
