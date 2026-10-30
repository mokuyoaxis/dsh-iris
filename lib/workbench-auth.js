// Single-owner browser authentication. No business storage, provider credentials or MCP grants.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createCoreRuntime } from './core-runtime.js';
import { atomicCreatePrivate, atomicWritePrivate } from './private-storage.js';

const scrypt = promisify(crypto.scrypt), TOKEN = /^[A-Za-z0-9_-]{43}$/, HEX = /^[a-f0-9]{64}$/;
const SESSION_MS = 12 * 60 * 60 * 1000, REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const inside = (root, target) => { const rel = path.relative(root, target); return !rel || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

export class WorkbenchAuthError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'WorkbenchAuthError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new WorkbenchAuthError(code, message, status); };
export const workbenchRootKey = dataRoot => hash(fs.realpathSync(dataRoot));

export function resolveWorkbenchAuthDirectory(dataRoot, supplied) {
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || !path.isAbsolute(supplied)) fail('IRIS_WEB_AUTH_CONFIG_INVALID', 'auth-store 必须是私有目录的绝对路径');
    return path.resolve(supplied);
  }
  const home = process.env.IRIS_HOME || path.join(os.homedir(), '.iris');
  if (!path.isAbsolute(home)) fail('IRIS_WEB_AUTH_CONFIG_INVALID', 'IRIS_HOME 必须是绝对路径');
  return path.join(home, 'web-auth', workbenchRootKey(dataRoot));
}

export function readWorkbenchPrivateJson(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || process.platform !== 'win32' && info.mode & 0o077) {
    fail('IRIS_WEB_AUTH_CONFIG_INVALID', '认证文件须为私有普通文件；不会调整已有文件权限', 409);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const bytes = Buffer.alloc(65537); let offset = 0, count;
    while (offset < bytes.length && (count = fs.readSync(fd, bytes, offset, bytes.length - offset, null))) offset += count;
    if (offset > 65536) fail('IRIS_WEB_AUTH_CONFIG_INVALID', '认证文件超过大小限制', 409);
    const text = bytes.subarray(0, offset).toString('utf8');
    let value;
    try { value = JSON.parse(text); } catch (_) { fail('IRIS_WEB_AUTH_CONFIG_INVALID', '认证文件不是有效 JSON，已保留现场', 409); }
    return { value, digest: hash(text) };
  } finally { fs.closeSync(fd); }
}

function prepareDirectory(directory, dataRoot) {
  const supplied = path.resolve(directory); let parent = supplied;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const physical = path.resolve(fs.realpathSync(parent), path.relative(parent, supplied));
  if (inside(dataRoot, physical) || inside(physical, dataRoot)) fail('IRIS_WEB_AUTH_CONFIG_INVALID', '认证目录与 Core 数据根须相互独立');
  if (!fs.existsSync(supplied)) fs.mkdirSync(supplied, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(supplied);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && info.mode & 0o077) {
    fail('IRIS_WEB_AUTH_CONFIG_INVALID', 'auth-store 须为私有真实目录；不会调整已有目录权限', 409);
  }
  return fs.realpathSync(supplied);
}

function checkedState(value, rootKey) {
  if (!fields(value, ['schemaVersion', 'rootKey', 'id', 'password', 'sessions']) || value.schemaVersion !== 0 || value.rootKey !== rootKey
      || !/^[a-f0-9]{32}$/.test(value.id) || !Array.isArray(value.sessions) || value.sessions.length > 32) {
    fail('IRIS_WEB_AUTH_CONFIG_INVALID', '认证状态的版本、根身份或结构不符合约定，已保留现场', 409);
  }
  const password = value.password;
  if (password !== null && (!fields(password, ['algorithm', 'salt', 'hash']) || password.algorithm !== 'scrypt-v1'
      || !/^[a-f0-9]{32}$/.test(password.salt) || !/^[a-f0-9]{128}$/.test(password.hash))) {
    fail('IRIS_WEB_AUTH_CONFIG_INVALID', '认证口令记录无效，不能自动修复或重置', 409);
  }
  if (new Set(value.sessions.map(item => item?.hash)).size !== value.sessions.length || password === null && value.sessions.length
      || value.sessions.some(item => !fields(item, ['hash', 'createdAt', 'expiresAt', 'remember']) || !HEX.test(item.hash)
        || typeof item.remember !== 'boolean' || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0
        || item.expiresAt !== item.createdAt + (item.remember ? REMEMBER_MS : SESSION_MS))) {
    fail('IRIS_WEB_AUTH_CONFIG_INVALID', '浏览器会话记录无效，已保留现场', 409);
  }
  return value;
}

function checkedPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    fail('IRIS_WEB_PASSWORD_INPUT_INVALID', '访问口令需为 8–128 个字符');
  }
  return password;
}
const derive = (password, salt) => scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

/** Explicit owner lease and atomic state. Session authority survives normal service restarts. */
export function createWorkbenchAuth({ directory, dataRoot }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('IRIS_WEB_AUTH_CONFIG_INVALID', 'auth-store 必须是明确的私有绝对路径');
  let phase = 'new', root, stateFile, controlFile, state, fingerprint, lease, bootstrap, control;
  let pending, disposal, failures = 0, failedWindow = 0;
  const rootKey = workbenchRootKey(dataRoot);
  const open = () => { if (phase !== 'open') fail('IRIS_WEB_AUTH_UNAVAILABLE', '工作台认证尚未启动或正在关闭', 503); };
  function persist(next) {
    open();
    if (readWorkbenchPrivateJson(stateFile).digest !== fingerprint) fail('IRIS_WEB_AUTH_CONFIG_CHANGED', '认证文件在服务外被修改，未覆盖；请在本机核对', 409);
    const text = json(next); atomicWritePrivate(stateFile, text); state = next; fingerprint = hash(text);
  }
  function start() {
    if (phase !== 'new') fail('IRIS_WEB_AUTH_UNAVAILABLE', '认证实例只能启动一次', 409);
    root = prepareDirectory(directory, fs.realpathSync(dataRoot)); stateFile = path.join(root, 'state.json'); controlFile = path.join(root, 'active.json');
    if (!fs.existsSync(stateFile)) {
      if (fs.readdirSync(root).some(name => name !== 'ownership')) fail('IRIS_WEB_AUTH_CONFIG_INVALID', '非空目录不是工作台认证目录，未覆盖文件', 409);
      try { atomicCreatePrivate(stateFile, json({ schemaVersion: 0, rootKey, id: crypto.randomBytes(16).toString('hex'), password: null, sessions: [] })); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const loaded = readWorkbenchPrivateJson(stateFile); state = checkedState(loaded.value, rootKey); fingerprint = loaded.digest;
    lease = createCoreRuntime({ dataRoot: path.join(root, 'ownership'), mode: 'writer' }); lease.start();
    // A previous owner may finish a logout between validation and lease acquisition.
    const owned = readWorkbenchPrivateJson(stateFile); state = checkedState(owned.value, rootKey); fingerprint = owned.digest;
    phase = 'open'; bootstrap = state.password === null ? crypto.randomBytes(32).toString('base64url') : null;
    return info();
  }
  function info() {
    open(); return { mode: 'password', configured: state.password !== null, authId: state.id, rememberDays: 30, minPasswordLength: 8, maxPasswordLength: 128 };
  }
  function bindControl({ origin, accessToken }) {
    open();
    if (fs.existsSync(controlFile)) readWorkbenchPrivateJson(controlFile);
    control = { schemaVersion: 0, rootKey, authId: state.id, state: 'open', pid: process.pid, origin, accessToken };
    atomicWritePrivate(controlFile, json(control));
  }
  function setupLink(origin) {
    open(); if (!bootstrap) fail('IRIS_WEB_PASSWORD_ALREADY_SET', '访问口令已设置，请在普通工作台地址登录', 409);
    return origin + '/#setup=' + bootstrap;
  }
  function authenticate(token) {
    open(); if (!TOKEN.test(token || '')) return false;
    const item = state.sessions.find(item => item.hash === hash(token));
    return !!item && item.expiresAt > Date.now();
  }
  function session(nextPassword, remember) {
    open();
    const alive = state.sessions.filter(item => item.expiresAt > Date.now());
    if (alive.length >= 32) fail('IRIS_WEB_SESSION_LIMIT', '已达 32 个有效会话，请退出闲置会话，或在本机重置口令', 429);
    const accessToken = crypto.randomBytes(32).toString('base64url'), createdAt = Date.now(), expiresAt = createdAt + (remember ? REMEMBER_MS : SESSION_MS);
    persist({ ...state, password: nextPassword, sessions: [...alive, { hash: hash(accessToken), createdAt, expiresAt, remember }] });
    return { authId: state.id, accessToken, expiresAt: new Date(expiresAt).toISOString(), remember };
  }
  function exclusive(callback) {
    open(); if (pending) fail('IRIS_WEB_AUTH_BUSY', '正在处理另一项登录请求，请稍后重试', 429);
    const job = Promise.resolve().then(callback); pending = job;
    return job.finally(() => { pending = null; });
  }
  function setup({ ticket, password, remember }) {
    checkedPassword(password);
    if (typeof remember !== 'boolean') fail('IRIS_WEB_PASSWORD_INPUT_INVALID', '请选择是否记住此设备');
    return exclusive(async () => {
      if (!bootstrap || !TOKEN.test(ticket || '') || !crypto.timingSafeEqual(Buffer.from(hash(ticket), 'hex'), Buffer.from(hash(bootstrap), 'hex'))) {
        fail('IRIS_WEB_SETUP_REQUIRED', '首次设置入口无效，请在本机运行 web login 获取当前设置入口', 401);
      }
      const salt = crypto.randomBytes(16).toString('hex'), derived = await derive(password, salt);
      try {
        const result = session({ algorithm: 'scrypt-v1', salt, hash: derived.toString('hex') }, remember);
        bootstrap = null; return result;
      } finally { derived.fill(0); }
    });
  }
  function login({ password, remember }) {
    checkedPassword(password);
    if (typeof remember !== 'boolean') fail('IRIS_WEB_PASSWORD_INPUT_INVALID', '请选择是否记住此设备');
    return exclusive(async () => {
      if (!state.password) fail('IRIS_WEB_SETUP_REQUIRED', '请先在本机完成工作台访问口令设置', 409);
      if (Date.now() - failedWindow >= 60000) { failures = 0; failedWindow = Date.now(); }
      if (failures >= 5) fail('IRIS_WEB_PASSWORD_RATE_LIMITED', '口令尝试过于频繁，请一分钟后重试', 429);
      const derived = await derive(password, state.password.salt);
      try {
        if (!crypto.timingSafeEqual(derived, Buffer.from(state.password.hash, 'hex'))) { failures++; fail('IRIS_WEB_PASSWORD_INVALID', '访问口令不正确', 401); }
      } finally { derived.fill(0); }
      failures = 0; return session(state.password, remember);
    });
  }
  function logout(token) {
    open(); if (!TOKEN.test(token || '')) fail('IRIS_WEB_PASSWORD_INPUT_INVALID', '浏览器会话格式无效');
    const remaining = state.sessions.filter(item => item.hash !== hash(token));
    if (remaining.length !== state.sessions.length) persist({ ...state, sessions: remaining });
    return { signedOut: true };
  }
  function reset() {
    return exclusive(() => { persist({ ...state, password: null, sessions: [] }); bootstrap = crypto.randomBytes(32).toString('base64url'); failures = 0; return { passwordReset: true }; });
  }
  function dispose() {
    if (disposal) return disposal;
    const wasOpen = phase === 'open'; phase = 'closing'; bootstrap = null;
    disposal = (async () => {
      if (pending) await Promise.allSettled([pending]);
      const errors = [];
      try { if (wasOpen && control) atomicWritePrivate(controlFile, json({ ...control, state: 'closed', accessToken: null })); } catch (error) { errors.push(error); }
      try { await lease?.dispose(); } catch (error) { errors.push(error); }
      phase = 'closed';
      if (errors.length) throw new AggregateError(errors, '工作台认证释放失败');
    })(); return disposal;
  }
  return Object.freeze({ start, info, bindControl, setupLink, authenticate, setup, login, logout, reset, dispose });
}
