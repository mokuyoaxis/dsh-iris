// Explicit owner-managed connection profiles. The business Core root and static grants are untouched.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCoreRuntime } from './core-runtime.js';
import { atomicCreatePrivate, atomicWritePrivate } from './private-storage.js';
import { checkedClientConnection, checkedConnectionScopes, checkedDeclaredClient, readPrivateConnectionJson, connectionFail } from './core-connections.js';
import { checkedBridgeCapabilities, checkedBridgeTools, selectedBridgeTools } from './core-bridge-selection.js';
import { exportMcpConfiguration } from './mcp-config.js';
import { checkedConnectionTemplate } from './connection-template.js';
import { connectionSkillResources } from './connection-skill.js';
import { bridgeToolsForScopes } from './core-bridge-tools.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const inside = (parent, file) => { const relative = path.relative(parent, file); return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
const invalid = message => connectionFail('IRIS_CONNECTION_INPUT_INVALID', message);
function privateDirectory(directory, create = false) {
  if (create && !fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && stat.mode & 0o077) {
    connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '连接管理目录必须是私有普通目录');
  }
}
function profile(input) {
  const { label, scopes, capabilities } = input;
  if (typeof label !== 'string' || !label.trim() || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) invalid('请输入 1–80 字符的连接名称');
  checkedConnectionScopes(scopes); checkedBridgeCapabilities(capabilities);
  const tools = input.tools === undefined ? selectedBridgeTools(capabilities) : checkedBridgeTools(input.tools);
  if (tools.some(name => !selectedBridgeTools(capabilities).includes(name))) invalid('工具不属于所选功能');
  return { label: label.trim(), scopes: [...scopes], capabilities: [...capabilities], tools };
}
function only(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) invalid('连接请求包含不支持的字段');
}

export function createManagedConnectionStore({ directory, dataRoot, rootId, getOrigin,
  availableScopes = ['read', 'create', 'execute', 'stop'], onChange = () => {}, beforeCreate = () => {} }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) invalid('连接管理目录须为显式根外绝对路径');
  checkedConnectionScopes(availableScopes);
  const records = new Map(), hashes = new Map(), templates = new Map();
  let root, owner, state = 'new', disposal;
  const fileFor = id => path.join(root, 'profiles', id + '.json');
  function grant(record) {
    return { rootId, connectionId: record.connectionId, adapterId: 'iris.mcp', harnessKind: 'generic', label: record.label,
      accessToken: record.accessToken, scopes: [...record.scopes], capabilities: [...record.capabilities], tools: [...record.tools] };
  }
  function checked(record) {
    only(record, ['schemaVersion', 'rootId', 'connectionId', 'accessToken', 'label', 'scopes', 'capabilities', 'tools',
      'revision', 'createdAt', 'updatedAt', 'revokedAt', 'creationDigest', 'lastContact']);
    if (record.schemaVersion !== 0 || record.rootId !== rootId || !UUID.test(record.connectionId)
        || !Number.isSafeInteger(record.revision) || record.revision < 1 || !/^[a-f0-9]{64}$/.test(record.creationDigest)
        || record.revokedAt !== null && typeof record.revokedAt !== 'string'
        || ![record.createdAt, record.updatedAt, ...(record.revokedAt !== null ? [record.revokedAt] : [])].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))) {
      connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '连接档案版本、身份或修订无效');
    }
    profile(record);
    const { scopes: _scopes, ...identity } = grant(record);
    checkedClientConnection({ schemaVersion: 0, origin: 'http://127.0.0.1:1', ...identity });
    if (record.lastContact !== null) {
      const contact = record.lastContact;
      if (!contact || Object.keys(contact).sort().join(',') !== 'at,clientInfo,source,transport' || contact.source !== 'client-declared'
          || !['stdio', 'http'].includes(contact.transport) || typeof contact.at !== 'string' || !Number.isFinite(Date.parse(contact.at))) {
        connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '客户端声明记录无效');
      }
      checkedDeclaredClient(contact.clientInfo);
    }
    return record;
  }
  function open() { if (state !== 'open') connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '连接管理尚未开启或已关闭'); }
  function read(id) {
    open();
    if (!UUID.test(id)) invalid('连接身份无效');
    const record = records.get(id);
    if (!record) connectionFail('IRIS_CONNECTION_NOT_FOUND', '没有此可管理连接');
    readPrivateConnectionJson(fileFor(id));
    if (sha(fs.readFileSync(fileFor(id))) !== hashes.get(id)) connectionFail('IRIS_CONNECTION_CONFIG_CHANGED', '档案在服务外被修改，请停用服务后核对，未覆盖文件');
    return record;
  }
  function persist(record, create = false) {
    const bytes = json(record);
    (create ? atomicCreatePrivate : atomicWritePrivate)(fileFor(record.connectionId), bytes);
    records.set(record.connectionId, structuredClone(record)); hashes.set(record.connectionId, sha(bytes));
    onChange(record.revokedAt ? null : grant(record), record.connectionId);
  }
  async function start() {
    if (state !== 'new') invalid('连接管理只能显式启动一次');
    const parent = fs.realpathSync(path.dirname(directory));
    root = path.join(parent, path.basename(directory));
    if (inside(dataRoot, root) || inside(root, dataRoot)) invalid('连接管理目录与 Core 数据根须相互独立');
    privateDirectory(root, true);
    const markerFile = path.join(root, 'store.json');
    if (!fs.existsSync(markerFile)) {
      if (fs.readdirSync(root).length) connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '现有非空目录不是 Iris 连接管理目录');
      atomicCreatePrivate(markerFile, json({ schemaVersion: 0, rootId }));
    }
    const marker = readPrivateConnectionJson(markerFile);
    if (Object.keys(marker).length !== 2 || marker.schemaVersion !== 0 || marker.rootId !== rootId) connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '连接管理目录属于其他数据空间或版本');
    for (const name of ['profiles', 'clients', 'ownership', 'templates']) privateDirectory(path.join(root, name), true);
    owner = createCoreRuntime({ dataRoot: path.join(root, 'ownership'), mode: 'writer' });
    try {
      owner.start();
      for (const name of fs.readdirSync(path.join(root, 'profiles'))) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '连接档案目录存在未知文件，已保留现场');
        const file = path.join(root, 'profiles', name), record = checked(readPrivateConnectionJson(file));
        if (name !== record.connectionId + '.json') connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '连接档案身份与文件名不一致');
        records.set(record.connectionId, record); hashes.set(record.connectionId, sha(fs.readFileSync(file)));
      }
      for (const name of fs.readdirSync(path.join(root, 'templates'))) {
        if (!/^[a-f0-9]{64}\.json$/.test(name) || templates.size >= 64) connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '模板目录存在未知文件或超过 64 项，已保留现场');
        const file = path.join(root, 'templates', name), template = checkedConnectionTemplate(readPrivateConnectionJson(file));
        if (sha(json(template)) + '.json' !== name || fs.readFileSync(file, 'utf8') !== json(template)) connectionFail('IRIS_CONNECTION_CONFIG_CHANGED', '模板内容与身份不一致，已保留现场');
        templates.set(name.slice(0, -5), template);
      }
      state = 'open'; return activeGrants();
    } catch (error) { await owner.dispose(); state = 'failed'; throw error; }
  }
  function activeGrants() { return [...records.values()].filter(value => !value.revokedAt).map(grant); }
  function list() {
    open();
    return [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.connectionId.localeCompare(b.connectionId))
      .map(({ accessToken: _secret, creationDigest: _input, ...record }) => ({ ...structuredClone(record),
      managed: true, state: record.revokedAt ? 'revoked' : record.lastContact ? 'used' : 'pending', harnessInstalled: 'unknown' }));
  }
  function create(input) {
    only(input, ['key', 'label', 'scopes', 'capabilities', 'tools']);
    if (!UUID.test(input.key)) invalid('新建连接需要稳定 UUID');
    const value = profile(input), creationDigest = sha(JSON.stringify(value));
    open();
    if (records.has(input.key)) {
      const existing = read(input.key);
      if (existing.creationDigest !== creationDigest) connectionFail('IRIS_CONNECTION_CONFIG_CHANGED', '此创建标识已用于另一套连接配置');
      return { connectionId: existing.connectionId, idempotentReplay: true };
    }
    beforeCreate(input.key);
    const now = new Date().toISOString();
    persist({ schemaVersion: 0, rootId, connectionId: input.key, accessToken: crypto.randomBytes(32).toString('base64url'),
      ...value, revision: 1, createdAt: now, updatedAt: now, revokedAt: null, creationDigest, lastContact: null }, true);
    return { connectionId: input.key, idempotentReplay: false };
  }
  function update(id, input) {
    only(input, ['expectedRevision', 'label', 'scopes', 'capabilities', 'tools']);
    const value = profile(input), record = read(id);
    if (record.revokedAt) connectionFail('IRIS_CONNECTION_REVOKED', '此连接已撤销，请新建连接');
    if (input.expectedRevision !== record.revision) connectionFail('IRIS_CONNECTION_CONFIG_CHANGED', '连接已改变，请刷新后重新编辑');
    persist({ ...record, ...value, revision: record.revision + 1, updatedAt: new Date().toISOString() });
    return { connectionId: id, revision: record.revision + 1 };
  }
  function revoke(id, input) {
    only(input, ['expectedRevision']);
    const record = read(id);
    if (record.revokedAt) return { connectionId: id, revoked: true, idempotentReplay: true };
    if (input.expectedRevision !== record.revision) connectionFail('IRIS_CONNECTION_CONFIG_CHANGED', '连接已改变，请刷新后撤销');
    const now = new Date().toISOString();
    persist({ ...record, revision: record.revision + 1, updatedAt: now, revokedAt: now });
    return { connectionId: id, revoked: true };
  }
  function observe(id, contact) {
    if (!records.has(id)) return;
    const record = read(id);
    if (record.revokedAt) return;
    // Display facts are checkpointed at first use, identity changes, and at most once a minute thereafter.
    if (record.lastContact && JSON.stringify(record.lastContact.clientInfo) === JSON.stringify(contact.clientInfo)
        && record.lastContact.transport === contact.transport && Date.parse(contact.at) - Date.parse(record.lastContact.at) < 60000) return;
    const next = { ...record, lastContact: contact };
    const bytes = json(next); atomicWritePrivate(fileFor(id), bytes);
    records.set(id, next); hashes.set(id, sha(bytes));
  }
  function listTemplates() {
    open();
    return [...templates.entries()].map(([templateId, template]) => {
      const file = path.join(root, 'templates', templateId + '.json');
      readPrivateConnectionJson(file);
      if (fs.readFileSync(file, 'utf8') !== json(template)) connectionFail('IRIS_CONNECTION_CONFIG_CHANGED', '模板在服务外被修改，已保留现场');
      return { templateId, ...structuredClone(template) };
    });
  }
  function importTemplate(input) {
    const template = checkedConnectionTemplate(input); open();
    const templateId = sha(json(template));
    if (templates.has(templateId)) { listTemplates(); return { templateId, idempotentReplay: true }; }
    if (templates.size >= 64) connectionFail('IRIS_CONNECTION_BUSY', '模板已达 64 项，请使用现有模板或手动选择格式');
    atomicCreatePrivate(path.join(root, 'templates', templateId + '.json'), json(template));
    templates.set(templateId, template); return { templateId, idempotentReplay: false };
  }
  function resolveExport(input) {
    only(input, ['transport', 'format', 'templateId']);
    if (input.templateId !== undefined) {
      if (Object.keys(input).length !== 1 || typeof input.templateId !== 'string') invalid('模板不能与手动格式混用');
      const template = listTemplates().find(item => item.templateId === input.templateId);
      if (!template) invalid('没有此接入模板');
      return { transport: template.transport, format: template.format };
    }
    if (!['stdio', 'http'].includes(input.transport) || !['mcpServers', 'entry'].includes(input.format)) invalid('配置格式无效');
    return { transport: input.transport, format: input.format };
  }
  function activeRecord(id) {
    const record = read(id);
    if (record.revokedAt) connectionFail('IRIS_CONNECTION_REVOKED', '已撤销连接不能导出');
    return record;
  }
  function exportSkill(id, input) {
    only(input, []);
    const record = activeRecord(id), scopes = record.scopes.filter(scope => availableScopes.includes(scope));
    const tools = bridgeToolsForScopes(scopes, record.capabilities, record.tools).map(tool => tool.name);
    if (!tools.length) invalid('此连接没有当前可用的工具，无法生成 Skill');
    const { bundle, bytes } = connectionSkillResources({ schemaVersion: 0, kind: 'iris-mcp-skill', rootId,
      connectionId: id, revision: record.revision, label: record.label, scopes, capabilities: record.capabilities, tools });
    return { bundle, preview: bytes['SKILL.md'].toString('utf8') };
  }
  function exportConfig(id, input) {
    const choice = resolveExport(input), record = activeRecord(id);
    const { scopes: savedScopes, ...identity } = grant(record);
    const scopes = savedScopes.filter(scope => availableScopes.includes(scope));
    const client = checkedClientConnection({ schemaVersion: 0, origin: getOrigin(), ...identity });
    if (choice.transport === 'http') {
      const entry = { url: getOrigin() + '/mcp', headers: { Authorization: 'Bearer ' + client.accessToken } };
      return { configuration: choice.format === 'entry' ? entry : { mcpServers: { iris: entry } }, containsCredentials: true };
    }
    const content = json(client), clientFile = path.join(root, 'clients', sha(content) + '.json');
    if (fs.existsSync(clientFile)) {
      readPrivateConnectionJson(clientFile);
      if (fs.readFileSync(clientFile, 'utf8') !== content) connectionFail('IRIS_CONNECTION_CONFIG_CHANGED', '导出副本被修改，已保留，未覆盖');
    } else atomicCreatePrivate(clientFile, content);
    return { configuration: exportMcpConfiguration({ connectionFile: clientFile, scopes, format: choice.format }), containsCredentials: false };
  }
  function dispose() {
    if (!disposal) { state = 'closing'; disposal = Promise.resolve(owner?.dispose()).then(() => { records.clear(); hashes.clear(); templates.clear(); state = 'closed'; }); }
    return disposal;
  }
  return Object.freeze({ start, activeGrants, list, create, update, revoke, observe,
    listTemplates, importTemplate, resolveExport, exportSkill, exportConfig, dispose });
}
