'use strict';
/**
 * Iris 请求守卫。
 *
 * `/iris/*` 不经过 DSH 的 `/api` 信任栅栏，因此默认只接受回环 Host。
 * LAN/反代场景需用 IRIS_TRUSTED_HOSTS 显式列出 host 或 host:port；这只是
 * Host 边界，不是身份认证。POST 另外校验 Sec-Fetch-Site 与 Origin==Host。
 */

/** 请求 Host 头 → host:port 规范化（小写，去 IPv6 方括号保留） */
function authority(header) {
  return String(header || '').trim().toLowerCase();
}

function hostnameOf(value) {
  try { return new URL('http://' + authority(value)).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase(); }
  catch (_) { return ''; }
}

function isLoopbackHost(hostname) {
  if (hostname === 'localhost' || hostname === '::1') return true;
  const match = hostname.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!match && match.slice(1).every((part) => Number(part) <= 255);
}

/** Host 是否属于默认回环或显式信任列表。列表格式：逗号分隔 host / host:port。 */
export function isTrustedHost(hostHeader, configured = process.env.IRIS_TRUSTED_HOSTS || '') {
  const host = authority(hostHeader);
  const hostname = hostnameOf(host);
  if (!host || !hostname) return false;
  if (isLoopbackHost(hostname)) return true;
  for (const raw of String(configured || '').split(',')) {
    const entry = authority(raw);
    if (!entry) continue;
    if (entry === host) return true;
    if (!entry.includes(':') && entry.replace(/\.$/, '') === hostname) return true;
  }
  return false;
}

/**
 * 纯函数裁决：{ok:true} 放行；否则 {ok:false, status, error}。
 * @param {{method?:string, headers?:object}} req node:http IncomingMessage 的最小面
 */
export function checkRequest(req, options = {}) {
  const headers = req.headers || {};
  const method = String(req.method || 'GET').toUpperCase();
  if (!isTrustedHost(headers.host, options.trustedHosts)) {
    return { ok: false, status: 403, error: 'untrusted host' };
  }
  if (method !== 'POST') return { ok: true };

  const sfs = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs === 'cross-site') return { ok: false, status: 403, error: 'cross-site request denied' };

  const origin = String(headers.origin || '');
  if (origin) {
    let oh = '';
    try {
      oh = new URL(origin).host.toLowerCase(); // host:port，与宿主 isTrustedApiRequest 同语义
    } catch (_) {
      return { ok: false, status: 403, error: 'bad origin' };
    }
    if (oh !== authority(headers.host)) return { ok: false, status: 403, error: 'cross-origin request denied' };
  }
  return { ok: true };
}

/** 包裹路由 handler：未授权请求统一 403 人话 JSON，不进业务 handler */
export function guarded(handler) {
  return (req, res, ...rest) => {
    const verdict = checkRequest(req);
    if (!verdict.ok) {
      if (res && !res.headersSent && typeof res.writeHead === 'function') {
        try {
          res.writeHead(verdict.status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
          res.end(JSON.stringify({ error: verdict.error }));
        } catch (_) {
          /* 连接已死 */
        }
      }
      return;
    }
    return handler(req, res, ...rest);
  };
}
