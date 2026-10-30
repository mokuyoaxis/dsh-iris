// CLI-only access to one explicitly selected workbench; no directory discovery or raw credential output.
import fs from 'node:fs';
import path from 'node:path';
import { createWorkbenchAuth, resolveWorkbenchAuthDirectory, readWorkbenchPrivateJson, workbenchRootKey, WorkbenchAuthError } from './workbench-auth.js';

export async function manageWorkbenchPassword({ dataRoot, directory: supplied, reset = false, signal }) {
  const directory = resolveWorkbenchAuthDirectory(dataRoot, supplied), file = path.join(directory, 'active.json');
  let active;
  if (fs.existsSync(file)) {
    active = readWorkbenchPrivateJson(file).value;
    if (!active || Object.keys(active).sort().join(',') !== 'accessToken,authId,origin,pid,rootKey,schemaVersion,state'
        || active.schemaVersion !== 0 || active.rootKey !== workbenchRootKey(dataRoot) || !['open', 'closed'].includes(active.state)
        || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(active.origin) || Number(active.origin.split(':').at(-1)) > 65535
        || !Number.isInteger(active.pid) || active.pid < 1 || !/^[a-f0-9]{32}$/.test(active.authId)
        || (active.state === 'open' ? !/^[A-Za-z0-9_-]{43}$/.test(active.accessToken) : active.accessToken !== null)) {
      throw new WorkbenchAuthError('IRIS_WEB_AUTH_CONFIG_INVALID', '工作台控制记录无效，已保留现场', 409);
    }
  }
  if (active?.state === 'open') {
    const request = async route => {
      const response = await fetch(active.origin + '/api/v0/workbench/' + route, { method: 'POST',
        headers: { Authorization: 'Bearer ' + active.accessToken, 'Content-Type': 'application/json' }, body: '{}', redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
      const value = await response.json();
      if (!response.ok) throw new WorkbenchAuthError(value.error?.code || 'IRIS_WEB_AUTH_UNAVAILABLE', value.error?.message || '工作台控制请求失败', response.status);
      return value;
    };
    if (reset) {
      const value = await request('password-reset');
      return { contractVersion: 0, origin: active.origin, loginUrl: value.setupUrl, passwordReset: true,
        message: '工作台会话已注销；打开设置链接重新设置访问口令。Core 任务与 MCP 连接保持。' };
    }
    const response = await fetch(active.origin + '/api/v0/workbench/auth', { redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
    const status = await response.json();
    if (!response.ok || status.authId !== active.authId || status.mode !== 'password') throw new WorkbenchAuthError('IRIS_WEB_AUTH_UNAVAILABLE', '工作台身份或认证模式已变化，请核对当前服务', 409);
    return { contractVersion: 0, origin: active.origin, loginUrl: status.configured ? active.origin : (await request('setup-link')).setupUrl,
      message: status.configured ? '打开工作台地址，用访问口令登录；记住设备后无需每次重新登录。' : '打开首次设置链接，设置一次访问口令。' };
  }
  if (!reset || !fs.existsSync(path.join(directory, 'state.json'))) {
    throw new WorkbenchAuthError('IRIS_WEB_AUTH_UNAVAILABLE', '工作台未运行，请先执行 web serve；无需手工指定 Token 文件', 409);
  }
  const auth = createWorkbenchAuth({ directory, dataRoot });
  try { auth.start(); await auth.reset(); }
  finally { await auth.dispose(); }
  return { contractVersion: 0, passwordReset: true, message: '访问口令已重置。下次 web serve 启动时打开首次设置入口；原任务和连接保持。' };
}
