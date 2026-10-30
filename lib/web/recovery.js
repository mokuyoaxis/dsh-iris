// A tab-local journal of identities only. Core records remain the source of truth.
export const RECOVERY_STORAGE_KEY = 'iris.workbench.recovery.v0';
export const MAX_RECOVERY_ACTIONS = 8;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IDS = { artifactId: /^artifact_[a-f0-9]{24}$/, runId: /^run_[a-f0-9]{24}$/, operationId: /^op_[a-f0-9]{64}$/ };
const FIELDS = {
  'image-import': ['key', 'artifactId'], 'flow-create': ['key', 'artifactId', 'runId'], 'generation-create': ['key', 'runId'],
  'audio-import': ['key', 'artifactId'], 'speech-create': ['key', 'runId'], 'transcription-create': ['key', 'artifactId', 'runId'],
  continue: ['key', 'runId', 'expectedRevision', 'operationId'],
  selection: ['runId', 'artifactId', 'expectedRevision'], stop: ['operationId']
};
const REQUIRED = {
  'image-import': ['key'], 'flow-create': ['key', 'artifactId'], 'generation-create': ['key'], continue: ['key', 'runId', 'expectedRevision'],
  'audio-import': ['key'], 'speech-create': ['key'], 'transcription-create': ['key', 'artifactId'],
  selection: ['runId', 'artifactId', 'expectedRevision'], stop: ['operationId']
};
export class WorkbenchMediaError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkbenchMediaError'; this.code = code; }
}
function fail(code, message) { throw new WorkbenchMediaError(code, message); }
function validAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(FIELDS, value.kind)
      || typeof value.id !== 'string' || !UUID.test(value.id)
      || Object.keys(value).some(key => !['id', 'kind', ...FIELDS[value.kind]].includes(key))
      || REQUIRED[value.kind].some(key => !Object.hasOwn(value, key))) return false;
  if (Object.hasOwn(value, 'key') && (typeof value.key !== 'string' || !UUID.test(value.key) || value.key !== value.id)) return false;
  if (Object.hasOwn(value, 'expectedRevision') && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) return false;
  return Object.entries(IDS).every(([key, pattern]) => !Object.hasOwn(value, key) || typeof value[key] === 'string' && pattern.test(value[key]));
}
function validTable(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 4
    && value.schemaVersion === 0 && typeof value.origin === 'string' && value.origin.length <= 256
    && typeof value.rootId === 'string' && UUID.test(value.rootId)
    && Array.isArray(value.actions) && value.actions.length <= MAX_RECOVERY_ACTIONS && value.actions.every(validAction)
    && new Set(value.actions.map(item => item.id)).size === value.actions.length;
}

export function createRecoveryJournal({ origin, rootId, getStorage = () => globalThis.sessionStorage }) {
  if (typeof origin !== 'string' || new URL(origin).origin !== origin || origin.length > 256
      || rootId !== null && (typeof rootId !== 'string' || !UUID.test(rootId))) throw new TypeError('工作台根身份无效');
  let actions = [], storage, mode = 'memory', notice = null, blocked = false, closed = false;
  try { storage = getStorage(); if (!storage) throw new TypeError('sessionStorage unavailable'); }
  catch (_) { notice = 'storage_unavailable'; }
  if (storage) {
    let raw;
    try { raw = storage.getItem(RECOVERY_STORAGE_KEY); }
    catch (_) { storage = null; notice = 'storage_unavailable'; }
    if (storage) {
      mode = rootId ? 'session' : 'memory';
      if (raw !== null) {
        let table;
        try { if (raw.length > 16384) throw new TypeError('recovery table too large'); table = JSON.parse(raw); }
        catch (_) { blocked = true; notice = 'corrupt'; }
        if (!blocked && !validTable(table)) { blocked = true; notice = 'corrupt'; }
        if (!blocked && (table.origin !== origin || table.rootId !== rootId)) {
          notice = 'root_changed';
          try { storage.removeItem(RECOVERY_STORAGE_KEY); }
          catch (_) { mode = 'memory'; notice = 'storage_unavailable'; }
        } else if (!blocked) actions = table.actions;
      }
    }
  }
  function open() {
    if (closed) throw new DOMException('工作台会话已关闭', 'AbortError');
    if (blocked) fail('IRIS_WEB_RECOVERY_CORRUPT', '待核对记录损坏；记录已保留，请明确清除后再发起新操作');
  }
  function persist() {
    if (mode !== 'session') return;
    try {
      if (actions.length) storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({ schemaVersion: 0, origin, rootId, actions }));
      else storage.removeItem(RECOVERY_STORAGE_KEY);
    } catch (_) { mode = 'memory'; notice = 'storage_unavailable'; }
  }
  const snapshot = () => ({ mode, notice, blocked, rootId, actions: structuredClone(actions) });
  return Object.freeze({
    snapshot,
    add(value) {
      open();
      if (!validAction(value)) throw new TypeError('待核对动作包含无效字段或标识');
      if (actions.length >= MAX_RECOVERY_ACTIONS) fail('IRIS_WEB_RECOVERY_FULL', '已有八项待核对操作，请先读取或明确处理原记录');
      if (actions.some(item => item.id === value.id)) throw new TypeError('待核对动作身份重复');
      actions.push(structuredClone(value)); persist();
    },
    update(id, patch) {
      open();
      const index = actions.findIndex(item => item.id === id);
      if (index < 0 || Object.keys(patch).some(key => !Object.hasOwn(IDS, key))) throw new TypeError('待核对动作更新无效');
      const next = { ...actions[index], ...patch };
      if (!validAction(next)) throw new TypeError('待核对动作结果标识无效');
      actions[index] = next; persist();
    },
    remove(id) {
      open(); const index = actions.findIndex(item => item.id === id);
      if (index < 0) throw new TypeError('待核对动作不存在');
      actions.splice(index, 1); persist();
    },
    clear() {
      if (closed) throw new DOMException('工作台会话已关闭', 'AbortError');
      actions = []; blocked = false; notice = rootId ? null : 'root_unavailable';
      try { storage?.removeItem(RECOVERY_STORAGE_KEY); }
      catch (_) { mode = 'memory'; notice = 'storage_unavailable'; }
    },
    close() { closed = true; }
  });
}
