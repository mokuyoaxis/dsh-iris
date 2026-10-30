// Loaded only by a password-mode shell. Stored authority is a browser session, never the owner control key.
import { WorkbenchHttpError } from './transport.js';

const TAB = 'iris.workbench.password-session.v0', DEVICE = 'iris.workbench.remembered-session.v0', SETUP = 'iris.workbench.setup.v0';
const TOKEN = /^[A-Za-z0-9_-]{43}$/, ID = /^[a-f0-9]{32}$/;
const $ = selector => document.querySelector(selector);

export function createWorkbenchLogin({ connect, disconnect, feedback, describe }) {
  let status, current, controller, generation = 0, busy = false, storageFailed = false;
  const validStatus = value => value?.contractVersion === 0 && value.mode === 'password' && typeof value.configured === 'boolean' && ID.test(value.authId);
  function storage(area, method, value) {
    try { return window[area][method](area === 'localStorage' ? DEVICE : value?.setup ? SETUP : TAB, value?.text); }
    catch (error) {
      if (!['SecurityError', 'QuotaExceededError', 'InvalidStateError'].includes(error.name)) throw error;
      storageFailed = true; return null;
    }
  }
  function notice() {
    $('#session-notice').hidden = !storageFailed;
    if (storageFailed) $('#session-notice').textContent = '浏览器无法保存部分登录信息。本次仍可使用，再次打开时可能需要输入访问口令。';
  }
  function cached(area) {
    const text = storage(area, 'getItem'); if (!text) return null;
    let value;
    try { if (text.length > 512) throw new Error('oversized'); value = JSON.parse(text); }
    catch (_) { storage(area, 'removeItem'); return null; }
    if (!value || Object.keys(value).sort().join(',') !== 'accessToken,authId,contractVersion,expiresAt,remember'
        || value.contractVersion !== 0 || value.authId !== status.authId || !TOKEN.test(value.accessToken || '')
        || typeof value.remember !== 'boolean' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
      storage(area, 'removeItem'); return null;
    }
    return value;
  }
  function saveSession(value) {
    if (!value || value.contractVersion !== 0 || value.authId !== status.authId || !TOKEN.test(value.accessToken || '')
        || !Number.isFinite(Date.parse(value.expiresAt)) || typeof value.remember !== 'boolean') throw new TypeError('不支持的工作台登录响应');
    current = value;
    storage('sessionStorage', 'setItem', { text: JSON.stringify(value) });
    if (value.remember) storage('localStorage', 'setItem', { text: JSON.stringify(value) });
    else storage('localStorage', 'removeItem');
    storage('sessionStorage', 'removeItem', { setup: true }); notice();
  }
  function setupTicket() {
    const text = storage('sessionStorage', 'getItem', { setup: true });
    if (!text) return null;
    let value;
    try { if (text.length > 256) throw new Error('oversized'); value = JSON.parse(text); } catch (_) { /* Clear invalid temporary setup state below. */ }
    if (value?.authId === status.authId && TOKEN.test(value.ticket || '')) return value.ticket;
    storage('sessionStorage', 'removeItem', { setup: true }); return null;
  }
  function render() {
    const setup = status?.configured === false;
    $('#password-login').hidden = false;
    $('#password-confirm-row').hidden = !setup;
    $('#password-confirm').required = setup;
    $('#password').autocomplete = setup ? 'new-password' : 'current-password';
    $('#password-submit').textContent = setup ? '设置口令并进入' : '进入工作台';
    $('#password-submit').disabled = busy || !status || setup && !setupTicket();
    $('#password').disabled = busy || !status || setup && !setupTicket();
    $('#password-confirm').disabled = busy;
    $('#password-retry').hidden = !!status;
    $('#password-hint').textContent = !status ? '正在读取工作台登录状态…' : setup
      ? setupTicket() ? '为这个工作台设置一个访问口令。之后用普通地址即可登录。'
        : '首次使用：请打开启动时给出的设置入口，或在本机运行 web login 获取设置入口。'
      : '用你的访问口令进入。记住此设备后，可跨正常重启继续使用。';
    notice();
  }
  async function request(route, value, signal, token) {
    const response = await fetch('/api/v0/workbench/' + route, { method: value ? 'POST' : 'GET',
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(value ? { body: JSON.stringify(value) } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const result = await response.json();
    if (!response.ok) throw new WorkbenchHttpError(response.status, result.error);
    return result;
  }
  async function open() {
    const turn = ++generation; controller?.abort(); controller = new AbortController();
    const signal = controller.signal; busy = true;
    $('#login-help').hidden = true; $('#paste-panel').hidden = true;
    $('#connection-title').textContent = '欢迎回到 Iris'; render();
    const fragment = location.hash.startsWith('#setup=') ? location.hash.slice(7) : null;
    if (fragment !== null || location.hash.startsWith('#login=')) history.replaceState(null, '', location.pathname + location.search);
    try {
      const value = await request('auth', undefined, signal);
      if (turn !== generation) return;
      if (!validStatus(value)) throw new TypeError('不支持的工作台认证响应');
      status = value;
      if (fragment !== null && !value.configured) {
        if (!TOKEN.test(fragment)) throw new Error('首次设置链接无效，请在本机运行 web login 获取当前入口。');
        storage('sessionStorage', 'setItem', { setup: true, text: JSON.stringify({ authId: status.authId, ticket: fragment }) });
      }
      if (!value.configured) {
        storage('sessionStorage', 'removeItem'); storage('localStorage', 'removeItem'); current = null;
      } else {
        storage('sessionStorage', 'removeItem', { setup: true });
        current = cached('sessionStorage') || cached('localStorage');
        if (current) await connect(current.accessToken);
      }
    } catch (error) { if (turn === generation) feedback(describe(error), true); }
    finally { if (turn === generation) { busy = false; render(); } }
  }
  function forget() {
    generation++; controller?.abort(); current = null;
    storage('sessionStorage', 'removeItem'); storage('localStorage', 'removeItem');
    $('#password').value = ''; $('#password-confirm').value = ''; busy = false; render();
  }
  async function logout() {
    if (busy || !current) return;
    const turn = ++generation, token = current.accessToken;
    controller?.abort(); controller = new AbortController(); busy = true; $('#disconnect').disabled = true;
    try {
      await request('logout', {}, controller.signal, token);
      if (turn !== generation) return;
      forget(); disconnect(); feedback('已退出。输入访问口令即可重新进入。'); $('#password').focus();
    } catch (error) { if (turn === generation) feedback('退出尚未确认，请重试。' + describe(error), true); }
    finally { if (turn === generation) busy = false; $('#disconnect').disabled = false; }
  }
  $('#password-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !status) return;
    const setup = !status.configured, password = $('#password').value;
    if (setup && password !== $('#password-confirm').value) { feedback('两次输入的访问口令不一致。', true); return; }
    const ticket = setup ? setupTicket() : undefined;
    if (setup && !ticket) { feedback('请打开本机启动器给出的首次设置入口。', true); return; }
    const turn = ++generation; controller?.abort(); controller = new AbortController(); busy = true; render();
    const remember = $('#password-remember').checked;
    $('#password').value = ''; $('#password-confirm').value = ''; feedback(setup ? '正在保存访问口令…' : '正在登录…');
    try {
      const result = await request(setup ? 'setup' : 'password-login', { password, remember, ...(setup ? { ticket } : {}) }, controller.signal);
      if (turn !== generation) return;
      status = { ...status, configured: true }; saveSession(result);
      await connect(result.accessToken);
    } catch (error) {
      if (turn !== generation) return;
      if (setup) {
        try {
          const latest = await request('auth', undefined, controller.signal);
          if (turn !== generation) return;
          if (!validStatus(latest) || latest.authId !== status.authId) throw new TypeError('不支持的工作台认证响应');
          status = latest;
          if (latest.configured) {
            storage('sessionStorage', 'removeItem', { setup: true });
            feedback('访问口令已设置。请直接输入口令登录工作台。'); return;
          }
        } catch (verification) {
          if (turn === generation) feedback(describe(error) + '；设置结果暂时无法核对：' + describe(verification), true);
          return;
        }
      }
      feedback(describe(error), true);
    }
    finally { if (turn === generation) { busy = false; render(); } }
  });
  $('#password-show').addEventListener('click', () => {
    const show = $('#password').type === 'password'; $('#password').type = show ? 'text' : 'password';
    $('#password-show').textContent = show ? '隐藏' : '显示'; $('#password-show').setAttribute('aria-pressed', String(show));
  });
  $('#password-retry').addEventListener('click', open);
  window.addEventListener('storage', event => {
    if (event.key === DEVICE && event.newValue === null && current?.remember) {
      forget(); disconnect(); feedback('此设备保存的登录已清除，请重新输入访问口令。');
    }
  });
  return Object.freeze({ open, logout, forget, pause() { generation++; controller?.abort(); busy = false; } });
}
