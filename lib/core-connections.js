import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectExecutionRoot } from './operation-store.js';
import { checkedBridgeCapabilities, checkedBridgeTools, selectedBridgeTools, DEFAULT_BRIDGE_CAPABILITIES, LEGACY_BRIDGE_TOOLS_V0 } from './core-bridge-selection.js';
import { CORE_SCOPE_DEFINITIONS } from './core-capability-catalog.js';
import { checkedPluginSelection, hasPluginSelection } from './plugin-selection.js';

export const CONNECTION_CONTRACT_VERSION = 0;
export const CONNECTION_SCOPES = Object.freeze(CORE_SCOPE_DEFINITIONS.map(scope => scope.id));
export const HARNESS_ADAPTERS = Object.freeze([
  Object.freeze({ adapterId: 'iris.mcp', harnessKinds: ['kimi', 'generic'], transport: 'stdio-to-local-http', contractVersions: [0] }),
  Object.freeze({ adapterId: 'iris.dsh-service', harnessKinds: ['dsh'], transport: 'local-http', contractVersions: [0] })
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hash = value => crypto.createHash('sha256').update(value).digest();
export function connectionFail(code, message) { throw Object.assign(new Error(message), { code }); }
function exact(value, fields, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key) && !optional.includes(key))
      || !fields.every(field => Object.hasOwn(value, field))) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '连接配置字段无效');
}
export function checkedCoreOrigin(value) {
  const match = typeof value === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[1]) > 65535) {
    connectionFail('IRIS_CONNECTION_INPUT_INVALID', 'Core 地址必须是 http://127.0.0.1:端口，不含路径或凭据');
  }
  return value;
}
function checkedIdentity(value) {
  const adapter = HARNESS_ADAPTERS.find(item => item.adapterId === value.adapterId);
  if (!adapter?.harnessKinds.includes(value.harnessKind) || !UUID.test(value.connectionId) || !UUID.test(value.rootId)
      || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80
      || /[\x00-\x1f\x7f]/.test(value.label)) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '接入身份或标签无效');
}
function checkedScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.includes('read') || scopes.length > CONNECTION_SCOPES.length || new Set(scopes).size !== scopes.length
      || scopes.some(scope => !CONNECTION_SCOPES.includes(scope))) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '连接权限必须包含 read，且仅允许已知的有限范围');
}
export { checkedScopes as checkedConnectionScopes };
export function checkedDeclaredClient(value) {
  exact(value, ['name', 'version'], ['title']);
  for (const item of Object.values(value)) {
    if (typeof item !== 'string' || !item.trim() || item.length > 160 || /[\x00-\x1f\x7f]/.test(item)) {
      connectionFail('IRIS_CONNECTION_INPUT_INVALID', '客户端声明需要有界名称与版本');
    }
  }
  return structuredClone(value);
}
export function projectedMcpClient(value) {
  if (!value || typeof value.name !== 'string' || typeof value.version !== 'string') return null;
  const text = item => item.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) || 'unknown';
  return { name: text(value.name), version: text(value.version), ...(typeof value.title === 'string' && value.title.trim() ? { title: text(value.title) } : {}) };
}
export function readPrivateConnectionJson(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '连接文件必须为显式绝对路径');
  let stat, value;
  try {
    stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || process.platform !== 'win32' && stat.mode & 0o077) throw new Error('private file required');
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '连接文件不可读、格式损坏或权限过宽'); }
  return value;
}
export function checkedClientConnection(value) {
  exact(value, ['schemaVersion', 'origin', 'rootId', 'connectionId', 'adapterId', 'harnessKind', 'label', 'accessToken'], ['capabilities', 'tools', 'pluginOperations']);
  if (value.schemaVersion !== 0 || !TOKEN.test(value.accessToken)) connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '连接凭据版本或格式不受支持');
  checkedIdentity(value); checkedCoreOrigin(value.origin);
  checkedPluginSelection(value.pluginOperations);
  return { ...structuredClone(value), capabilities: checkedBridgeCapabilities(value.capabilities === undefined ? DEFAULT_BRIDGE_CAPABILITIES : value.capabilities),
    tools: checkedBridgeTools(value.tools === undefined ? LEGACY_BRIDGE_TOOLS_V0 : value.tools) };
}
export function readConnectionGrants(file) {
  const value = readPrivateConnectionJson(file);
  exact(value, ['schemaVersion', 'grants']);
  if (value.schemaVersion !== 0 || !Array.isArray(value.grants) || !value.grants.length || value.grants.length > 32) {
    connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '需要 1–32 个显式连接授权');
  }
  const ids = new Set(), tokens = new Set();
  for (const grant of value.grants) {
    exact(grant, ['rootId', 'connectionId', 'adapterId', 'harnessKind', 'label', 'accessToken', 'scopes'], ['capabilities', 'tools', 'pluginOperations']);
    checkedIdentity(grant); checkedScopes(grant.scopes);
    checkedPluginSelection(grant.pluginOperations);
    checkedBridgeCapabilities(grant.capabilities === undefined ? DEFAULT_BRIDGE_CAPABILITIES : grant.capabilities);
    checkedBridgeTools(grant.tools === undefined ? LEGACY_BRIDGE_TOOLS_V0 : grant.tools);
    if (!TOKEN.test(grant.accessToken) || ids.has(grant.connectionId) || tokens.has(grant.accessToken)) connectionFail('IRIS_CONNECTION_CONFIG_INVALID', '连接身份或凭据重复/无效');
    ids.add(grant.connectionId); tokens.add(grant.accessToken);
  }
  return value.grants.map(grant => ({ ...structuredClone(grant), capabilities: [...(grant.capabilities ?? DEFAULT_BRIDGE_CAPABILITIES)],
    tools: [...(grant.tools ?? LEGACY_BRIDGE_TOOLS_V0)] }));
}
/** Explicit new pairing directory. No harness configuration discovery or modification. */
export function createConnectionPair({ dataRoot, directory, origin, harnessKind = 'generic', label, scopes = ['read'], capabilities = DEFAULT_BRIDGE_CAPABILITIES, tools, pluginOperations } = {}) {
  checkedCoreOrigin(origin); checkedScopes(scopes);
  checkedBridgeCapabilities(capabilities);
  pluginOperations = checkedPluginSelection(pluginOperations);
  tools = tools === undefined ? selectedBridgeTools(capabilities, undefined, pluginOperations) : checkedBridgeTools(tools);
  if (tools.some(name => !selectedBridgeTools(capabilities, undefined, pluginOperations).includes(name))) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '工具不属于所选功能分组');
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '需要明确的 v1 数据根绝对路径');
  const adapterId = harnessKind === 'dsh' ? 'iris.dsh-service' : 'iris.mcp';
  const root = fs.realpathSync(dataRoot), marker = inspectExecutionRoot(root);
  const client = { schemaVersion: 0, origin, rootId: marker.rootId, connectionId: crypto.randomUUID(), adapterId, harnessKind, label,
    accessToken: crypto.randomBytes(32).toString('base64url'), capabilities: [...capabilities], tools: [...tools], ...(pluginOperations.length ? { pluginOperations } : {}) };
  checkedClientConnection(client);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '输出目录须为新的绝对路径');
  const relative = path.relative(root, path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory)));
  if (!relative || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '连接凭据须存放在数据根之外');
  fs.mkdirSync(directory, { mode: 0o700 });
  const serverFile = path.join(directory, 'server-grants.json'), clientFile = path.join(directory, 'client.json');
  const { schemaVersion: _version, origin: _origin, ...grant } = client;
  fs.writeFileSync(serverFile, JSON.stringify({ schemaVersion: 0, grants: [{ ...grant, scopes }] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(clientFile, JSON.stringify(client, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { contractVersion: 0, connectionId: client.connectionId, adapterId, harnessKind, scopes, capabilities, tools, serverFile, clientFile };
}

/** Authenticated, per-connection and per-runtime facts. No filesystem or Provider access. */
export function createConnectionRegistry(grants, availableScopes, { onClientInfo = () => {}, availableCapabilities, availableTools } = {}) {
  const configured = new Map(grants.map(grant => {
    const { accessToken, ...publicGrant } = grant;
    return [grant.connectionId, { ...structuredClone(publicGrant), capabilities: [...(grant.capabilities ?? DEFAULT_BRIDGE_CAPABILITIES)],
      tools: [...(grant.tools ?? LEGACY_BRIDGE_TOOLS_V0)], tokenDigest: hash(accessToken), instances: new Map() }];
  }));
  function identify(connectionId, token) {
    const grant = configured.get(connectionId);
    if (!grant || !TOKEN.test(token) || !crypto.timingSafeEqual(hash(token), grant.tokenDigest)) connectionFail('IRIS_CONNECTION_AUTH_REQUIRED', '连接身份或凭据无效');
    return grant.connectionId;
  }
  function handshake(connectionId, value) {
    exact(value, ['contractVersion', 'adapterId', 'harnessKind', 'runtimeInstanceId', 'harnessVersion', 'requestedScopes'], ['requestedCapabilities', 'requestedTools', 'requestedPluginOperations']);
    const grant = configured.get(connectionId);
    if (value.contractVersion !== 0) connectionFail('IRIS_CONNECTION_VERSION_UNSUPPORTED', '连接契约版本不受支持');
    if (value.adapterId !== grant.adapterId || value.harnessKind !== grant.harnessKind || !UUID.test(value.runtimeInstanceId)
        || typeof value.harnessVersion !== 'string' || value.harnessVersion.length > 80 || /[\x00-\x1f\x7f]/.test(value.harnessVersion)) {
      connectionFail('IRIS_CONNECTION_INPUT_INVALID', '握手身份不符合本地授权');
    }
    checkedScopes(value.requestedScopes);
    const capabilities = checkedBridgeCapabilities(value.requestedCapabilities === undefined ? grant.capabilities : value.requestedCapabilities);
    const tools = checkedBridgeTools(value.requestedTools === undefined ? grant.tools : value.requestedTools);
    const pluginOperations = checkedPluginSelection(value.requestedPluginOperations === undefined ? grant.pluginOperations : value.requestedPluginOperations);
    if (pluginOperations.some(pin => !hasPluginSelection(grant.pluginOperations || [], pin))) connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '插件业务或版本不在明确授权中');
    if (value.requestedScopes.some(scope => !grant.scopes.includes(scope) || !availableScopes.includes(scope))) {
      connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '请求的能力未获授权或服务未开启');
    }
    if (capabilities.some(id => !grant.capabilities.includes(id) || availableCapabilities && !availableCapabilities.includes(id)) || tools.some(name => !grant.tools.includes(name))) {
      connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '请求的功能或工具未获本地授权');
    }
    if (!grant.instances.has(value.runtimeInstanceId) && grant.instances.size >= 8) {
      const retired = [...grant.instances.values()].find(instance => instance.state === 'disconnected');
      if (retired) grant.instances.delete(retired.runtimeInstanceId);
      else connectionFail('IRIS_CONNECTION_BUSY', '该连接实例数量已达上限，请由 owner 明确断开旧实例');
    }
    const now = new Date().toISOString(), instance = { runtimeInstanceId: value.runtimeInstanceId, harnessVersion: value.harnessVersion,
      connectedAt: now, lastSeenAt: now, state: 'connected', scopes: [...value.requestedScopes], capabilities,
      tools: selectedBridgeTools(capabilities, tools, pluginOperations).filter(name => availableTools === undefined || availableTools.includes(name)),
      ...(pluginOperations.length ? { pluginOperations } : {}),
      verification: 'handshake', liveness: 'not_probed' };
    grant.instances.set(value.runtimeInstanceId, instance);
    return { contractVersion: 0, rootId: grant.rootId, connectionId, adapterId: grant.adapterId, harnessKind: grant.harnessKind,
      instance: structuredClone(instance), remoteHostPorts: [], connectionFeatures: ['client-info'] };
  }
  function authorize(connectionId, runtimeInstanceId, scope, tool) {
    const grant = configured.get(connectionId), instance = grant?.instances.get(runtimeInstanceId);
    if (!instance || instance.state !== 'connected') connectionFail('IRIS_CONNECTION_HANDSHAKE_REQUIRED', '请先完成本次服务的连接握手');
    if (!instance.scopes.includes(scope)) connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '此连接未获该操作权限');
    if (tool && !instance.tools.includes(tool)) connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '此功能或工具未被用户选择');
    instance.lastSeenAt = new Date().toISOString();
    return [...instance.scopes];
  }
  function disconnect(connectionId, runtimeInstanceId) {
    const instance = configured.get(connectionId)?.instances.get(runtimeInstanceId);
    if (!instance) connectionFail('IRIS_CONNECTION_HANDSHAKE_REQUIRED', '没有此连接实例');
    instance.state = 'disconnected'; instance.lastSeenAt = new Date().toISOString();
    return { contractVersion: 0, disconnected: true };
  }
  function list(connectionId) {
    return { contractVersion: 0, adapters: structuredClone(HARNESS_ADAPTERS), connections: [...configured.values()]
      .filter(grant => connectionId === undefined || grant.connectionId === connectionId)
      .map(({ tokenDigest: _secret, instances, ...grant }) => ({ ...structuredClone(grant), configured: true,
        harnessInstalled: 'unknown', instances: [...instances.values()].map(instance => structuredClone(instance)) })) };
  }
  function dispose() { for (const grant of configured.values()) grant.tokenDigest.fill(0); configured.clear(); }
  function selection(connectionId, runtimeInstanceId) {
    const instance = configured.get(connectionId).instances.get(runtimeInstanceId);
    return { capabilities: [...instance.capabilities], tools: [...instance.tools], ...(instance.pluginOperations?.length ? { pluginOperations: structuredClone(instance.pluginOperations) } : {}) };
  }
  function clientInfo(connectionId, runtimeInstanceId, value) {
    exact(value, ['clientInfo', 'transport']);
    const info = checkedDeclaredClient(value.clientInfo);
    if (!['stdio', 'http'].includes(value.transport)) connectionFail('IRIS_CONNECTION_INPUT_INVALID', 'MCP 传输声明无效');
    const instance = configured.get(connectionId)?.instances.get(runtimeInstanceId);
    if (!instance || instance.state !== 'connected') connectionFail('IRIS_CONNECTION_HANDSHAKE_REQUIRED', '请先连接当前实例');
    const contact = { clientInfo: info, transport: value.transport, source: 'client-declared', at: new Date().toISOString() };
    onClientInfo(connectionId, contact);
    instance.declaredClient = contact; instance.lastSeenAt = contact.at;
    return { contractVersion: 0, recorded: true };
  }
  function setGrant(grant) {
    const old = configured.get(grant.connectionId), { accessToken, ...publicGrant } = grant;
    const same = old && crypto.timingSafeEqual(old.tokenDigest, hash(accessToken))
      && ['adapterId', 'harnessKind', 'scopes', 'capabilities', 'tools', 'pluginOperations'].every(key => JSON.stringify(old[key]) === JSON.stringify(publicGrant[key]));
    if (old) old.tokenDigest.fill(0);
    configured.set(grant.connectionId, { ...structuredClone(publicGrant), tokenDigest: hash(accessToken), instances: same ? old.instances : new Map() });
    return { authorizationChanged: !same };
  }
  function revoke(connectionId) {
    const grant = configured.get(connectionId);
    if (grant) { grant.tokenDigest.fill(0); configured.delete(connectionId); }
  }
  function identifyMcp(token) {
    if (!TOKEN.test(token)) connectionFail('IRIS_CONNECTION_AUTH_REQUIRED', '需要明确的 MCP 连接凭据');
    const tokenDigest = hash(token);
    const grant = [...configured.values()].find(item => crypto.timingSafeEqual(tokenDigest, item.tokenDigest));
    if (!grant) connectionFail('IRIS_CONNECTION_AUTH_REQUIRED', 'MCP 连接凭据无效');
    if (grant.adapterId !== 'iris.mcp') connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '此凭据没有授权 MCP 接入');
    const { tokenDigest: _secret, instances: _instances, ...publicGrant } = grant;
    return structuredClone(publicGrant);
  }
  function authorizePlugin(connectionId, dependency) {
    const grant = configured.get(connectionId);
    if (!grant?.scopes.includes('execute') || !grant.tools.includes('iris_core_plugin_call') || !hasPluginSelection(grant.pluginOperations || [], dependency)) {
      connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '原连接的插件业务执行授权已缩减或撤销');
    }
  }
  return Object.freeze({ identify, identifyMcp, handshake, authorize, authorizePlugin, selection, disconnect, list, clientInfo, setGrant, revoke, dispose });
}
