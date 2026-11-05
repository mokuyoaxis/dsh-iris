// Owner CLI resources and explicit bindings. Editing never sends network traffic.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicCreatePrivate, atomicWritePrivate, ensurePrivateDir, privateSibling } from './private-storage.js';
import { NETWORK_CONFIG_VERSION, NETWORK_ROUTING_CONFIG_VERSION, NETWORK_CONFIG_MAX_BYTES, networkConfigFail as fail, networkFields, normalizeNetworkNode, normalizeNetworkPool, validateNetworkConfig, projectNetworkConfig } from './network-config.js';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function absolute(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('IRIS_NETWORK_CONFIG_INVALID', 'network-config 必须是显式绝对路径');
}
function io(action) {
  try { return action(); }
  catch (error) {
    if (typeof error.code !== 'string' || typeof error.syscall !== 'string') throw error;
    const detail = /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code) ? `（${error.code}）` : '';
    fail('IRIS_NETWORK_CONFIG_IO', `网络配置文件操作失败${detail}，请检查目录权限、可用空间与文件状态；原文件和已有备份不会自动清理`);
  }
}
export function readNetworkConfig(file) {
  absolute(file);
  const info = io(() => fs.lstatSync(file));
  if (!info.isFile() || info.isSymbolicLink()) fail('IRIS_NETWORK_CONFIG_INVALID', 'network-config 必须是普通文件，不能使用符号链接');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail('IRIS_NETWORK_CONFIG_PERMISSIONS', 'network-config 权限过宽，请限制为仅当前用户可读写');
  if (info.size > NETWORK_CONFIG_MAX_BYTES) fail('IRIS_NETWORK_CONFIG_INVALID', 'network-config 不能超过1 MiB');
  const bytes = io(() => fs.readFileSync(file));
  if (bytes.length > NETWORK_CONFIG_MAX_BYTES) fail('IRIS_NETWORK_CONFIG_INVALID', 'network-config 不能超过1 MiB');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch (_) { fail('IRIS_NETWORK_CONFIG_INVALID', 'network-config 不是有效 JSON；请修正原文件，不会自动回退'); }
  return { config: validateNetworkConfig(parsed), bytes, revision: digest(bytes) };
}

const READS = ['show', 'check', 'nodes.list', 'pools.list', 'bindings.list'];
const WRITES = ['nodes.add', 'nodes.set', 'nodes.remove', 'pools.add', 'pools.set', 'pools.remove', 'bindings.set', 'bindings.remove'];
export function executeNetworkConfigCommand(file, command, input = {}, { signal, env = process.env } = {}) {
  absolute(file); signal?.throwIfAborted();
  if (['init', 'routing.init', 'routing.copy'].includes(command)) {
    const copy = command === 'routing.copy', routing = command !== 'init';
    networkFields(input, copy ? ['source'] : [], copy ? ['source'] : []);
    const source = copy ? readNetworkConfig(input.source).config : undefined;
    const config = { schemaVersion: routing ? NETWORK_ROUTING_CONFIG_VERSION : NETWORK_CONFIG_VERSION,
      configId: crypto.randomUUID(), generation: 1, nodes: source?.nodes || [], pools: source?.pools || [], ...(routing ? { bindings: [] } : {}) };
    io(() => {
      ensurePrivateDir(path.dirname(file));
      try { atomicCreatePrivate(file, JSON.stringify(config, null, 2) + '\n'); }
      catch (error) { if (error.code === 'EEXIST') fail('IRIS_NETWORK_CONFIG_EXISTS', '网络配置已存在，初始化不会覆盖；请先读取并核对'); throw error; }
    });
    const saved = readNetworkConfig(file);
    return { command, created: true, ...projectNetworkConfig(saved.config, saved.revision, env) };
  }
  if (!READS.includes(command) && !WRITES.includes(command)) fail('IRIS_NETWORK_CONFIG_INVALID', '不支持的网络配置命令');
  const before = readNetworkConfig(file);
  if (command.startsWith('bindings.') && before.config.schemaVersion !== NETWORK_ROUTING_CONFIG_VERSION) {
    fail('IRIS_NETWORK_CONFIG_VERSION', '绑定只用于显式新建的 v2 网络配置；可用 routing.copy 另存新文件，原文件不会自动迁移');
  }
  if (READS.includes(command)) {
    networkFields(input, []);
    return { command, ...(command === 'check' ? { valid: true, networkTested: false } : {}), ...projectNetworkConfig(before.config, before.revision, env) };
  }
  const [group, verb] = command.split('.'), field = group === 'nodes' ? 'node' : 'pool';
  const fields = group === 'bindings' ? ['expectedRevision', 'catalogId', 'providerId', ...(verb === 'set' ? ['poolId'] : ['confirm'])]
    : verb === 'remove' ? ['expectedRevision', 'id', 'confirm'] : ['expectedRevision', field];
  networkFields(input, fields, fields);
  if (input.expectedRevision !== before.revision) fail('IRIS_NETWORK_CONFIG_CHANGED', '网络配置已变化，请重新读取后核对编辑');
  const next = structuredClone(before.config), records = next[group];
  if (group === 'bindings') {
    const index = records.findIndex(binding => binding.catalogId === input.catalogId && binding.providerId === input.providerId);
    if (verb === 'remove') {
      if (input.confirm !== true) fail('IRIS_NETWORK_CONFIG_INVALID', '删除绑定需要明确 confirm:true');
      if (index < 0) fail('IRIS_NETWORK_CONFIG_NOT_FOUND', '所选绑定不存在');
      records.splice(index, 1);
    } else {
      const binding = { catalogId: input.catalogId, providerId: input.providerId, poolId: input.poolId };
      if (index < 0) records.push(binding); else records[index] = binding;
    }
  } else if (verb === 'remove') {
    if (input.confirm !== true) fail('IRIS_NETWORK_CONFIG_INVALID', '删除资源需要明确 confirm:true');
    const index = records.findIndex(record => record.id === input.id);
    if (index < 0) fail('IRIS_NETWORK_CONFIG_NOT_FOUND', '所选网络资源不存在');
    if (group === 'nodes' && next.pools.some(pool => pool.candidates.some(candidate => candidate.kind === 'node' && candidate.nodeId === input.id))) {
      fail('IRIS_NETWORK_CONFIG_IN_USE', '节点仍被池引用；请先显式编辑或移除引用，停用的池也保留引用');
    }
    if (group === 'pools' && next.bindings?.some(binding => binding.poolId === input.id)) {
      fail('IRIS_NETWORK_CONFIG_IN_USE', '池仍被供应商绑定引用；请先显式解除绑定，停用的池也保留引用');
    }
    records.splice(index, 1);
  } else {
    const supplied = input[field];
    networkFields(supplied, group === 'nodes' ? ['id', 'label', 'enabled', 'protocol', 'host', 'port', 'auth'] : ['id', 'label', 'enabled', 'mode', 'candidates'], ['id']);
    const index = records.findIndex(record => record.id === supplied.id);
    if (verb === 'add' && index !== -1) fail('IRIS_NETWORK_CONFIG_EXISTS', '同类网络资源 ID 已存在，不能覆盖');
    if (verb === 'set' && index === -1) fail('IRIS_NETWORK_CONFIG_NOT_FOUND', '所选网络资源不存在');
    const normalize = group === 'nodes' ? normalizeNetworkNode : normalizeNetworkPool;
    const record = normalize(verb === 'set' ? { ...records[index], ...supplied } : supplied);
    if (verb === 'set') records[index] = record; else records.push(record);
  }
  const validated = validateNetworkConfig(next);
  const changed = JSON.stringify(validated) !== JSON.stringify(before.config);
  let fd;
  try { fd = io(() => {
    try { return fs.openSync(file + '.lock', 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('IRIS_NETWORK_CONFIG_BUSY', '网络配置正在修改或留有未核查的锁；不会自动删除或抢占，请核查写入进程'); throw error; }
  });
    // Revalidate the schema before CAS; a newer writer must never be downgraded.
    const current = readNetworkConfig(file);
    if (current.revision !== before.revision) fail('IRIS_NETWORK_CONFIG_CHANGED', '网络配置在编辑期间变化，请重新读取后核对');
    signal?.throwIfAborted();
    if (!changed) return { command, changed: false, ...projectNetworkConfig(current.config, current.revision, env) };
    if (validated.generation === Number.MAX_SAFE_INTEGER) fail('IRIS_NETWORK_CONFIG_INVALID', '网络配置修订已超出支持范围');
    validated.generation++;
    const encoded = Buffer.from(JSON.stringify(validated, null, 2) + '\n');
    if (encoded.length > NETWORK_CONFIG_MAX_BYTES) fail('IRIS_NETWORK_CONFIG_INVALID', 'network-config 不能超过1 MiB');
    const backupPath = privateSibling(file, 'backup');
    io(() => {
      fs.writeFileSync(backupPath, before.bytes, { flag: 'wx', mode: 0o600 });
      atomicWritePrivate(file, encoded);
    });
    return { command, changed: true, backupPath, ...projectNetworkConfig(validated, digest(encoded), env) };
  } finally {
    if (fd !== undefined) io(() => { try { fs.closeSync(fd); } finally { fs.unlinkSync(file + '.lock'); } });
  }
}
