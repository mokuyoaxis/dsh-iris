/** Local browser navigation address. Public media links keep their separate webBase() contract. */
const DEFAULT_BASE = 'http://127.0.0.1:3080';

function invalid(source, message) {
  return Object.freeze({ source, status: 'invalid', code: 'IRIS_RENDER_ADDRESS_INVALID', message });
}

function checkedBase(value, source) {
  let url;
  try { url = new URL(value); }
  catch (_) { return invalid(source, '截图地址无法解析；请设置有效的 DSH_WEB_BASE HTTP(S) 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    return invalid(source, '截图地址必须为 HTTP(S)，且不能包含登录凭据、查询参数或片段；请核对 DSH_WEB_BASE。');
  }
  return Object.freeze({ source, status: 'resolved', baseUrl: url.href.replace(/\/+$/, '') });
}

/** Only documented host/port/protocol properties are read; no request headers or private config. */
export function resolveRenderAddress(listener, override = process.env.DSH_WEB_BASE) {
  if (override) return checkedBase(String(override).trim(), 'environment');
  const port = listener?.port;
  const host = listener?.host;
  if (typeof host !== 'string' || !host || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return Object.freeze({ source: 'default', status: 'fallback', baseUrl: DEFAULT_BASE,
      message: '宿主未提供实际监听地址，暂用 127.0.0.1:3080；非默认部署请设置 DSH_WEB_BASE。' });
  }
  // Older supported DSH listeners are HTTP-only and have no protocol property.
  const protocol = listener.protocol ?? 'http:';
  if (!['http:', 'https:'].includes(protocol) || /[\s/@?#\\%]/.test(host)) {
    return invalid('host', '宿主监听地址不能直接用于截图；请通过 DSH_WEB_BASE 指定浏览器可访问的 HTTP(S) 地址。');
  }
  const localHost = host === '0.0.0.0' ? '127.0.0.1' : (host === '::' || host === '[::]' ? '::1' : host);
  const urlHost = localHost.includes(':') && !localHost.startsWith('[') ? '[' + localHost + ']' : localHost;
  return checkedBase(protocol + '//' + urlHost + ':' + port, 'host');
}
