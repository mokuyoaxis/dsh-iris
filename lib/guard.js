'use strict';
/**
 * Iris 请求守卫（O2 授权边界，2026-09-03）。
 *
 * 宿主安全模型是「loopback = trusted local machine」：webServer 绑定 127.0.0.1，
 * 路由分发无任何鉴权。同源不等于授权——iris 路由面存在两条真实攻击路径：
 *
 * ① 驱动式 CSRF：任意恶意网页可对 http://127.0.0.1:3080/iris/api/actions/* 发
 *    简单 POST（不触发 CORS 预检）——响应读不到，但动作会执行（真实付费生成、
 *    写盘、起浏览器标签页）。
 * ② DNS 重绑定：攻击者域名解析到 127.0.0.1 后浏览器视其为同源——CORS 与
 *    Sec-Fetch 防线全失效，但 **Host 头仍是攻击者域名**，Host 白名单可斩断。
 *
 * 策略（纵深防御，宿主不受影响，仅收紧 /iris/*）：
 * - 所有方法：Host 主机名必须在回环白名单（127.0.0.1 / localhost / ::1）∪
 *   DSH_WEB_BASE 覆盖的主机内（反代/远程部署显式声明的基址）。
 * - POST：Origin 存在时必须同源；Sec-Fetch-Site 存在时拒绝 cross-site /
 *   same-site（跨站发起）。无 Origin 的非浏览器客户端（本机 CLI/curl）放行——
 *   它们已受 Host 关约束（能直连回环的本机进程本就在信任域内）。
 * - 媒体通道另有 token 能力凭证，本守卫是第二层。
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** 允许的主机名集合：回环 + DSH_WEB_BASE 显式声明的基址主机 */
export function allowedHosts() {
  const set = new Set(LOOPBACK_HOSTS);
  const base = String(process.env.DSH_WEB_BASE || '').trim();
  if (base) {
    try {
      const h = new URL(base).hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (h) set.add(h);
    } catch (_) {
      /* 非法 DSH_WEB_BASE 不参与白名单（media.webBase 自有兜底） */
    }
  }
  return set;
}

/** Host 头 → 主机名（去端口、去 IPv6 方括号、小写） */
function hostName(header) {
  const h = String(header || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']'); // [::1] 或 [::1]:3080
    if (end > 0) return h.slice(1, end);
    return h;
  }
  const i = h.lastIndexOf(':');
  if (i > 0 && /^\d+$/.test(h.slice(i + 1))) return h.slice(0, i); // 去端口
  return h;
}

/**
 * 纯函数裁决：{ok:true} 放行；否则 {ok:false, status, error}。
 * @param {{method?:string, headers?:object}} req node:http IncomingMessage 的最小面
 */
export function checkRequest(req) {
  const headers = req.headers || {};
  const hosts = allowedHosts();
  const host = hostName(headers.host);
  if (!host || !hosts.has(host)) {
    return { ok: false, status: 403, error: 'host not allowed' };
  }
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'POST') {
    const sfs = String(headers['sec-fetch-site'] || '').toLowerCase();
    if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
      return { ok: false, status: 403, error: 'cross-site request denied' };
    }
    const origin = String(headers.origin || '');
    if (origin) {
      let oh = '';
      try {
        oh = new URL(origin).hostname.toLowerCase();
      } catch (_) {
        return { ok: false, status: 403, error: 'bad origin' };
      }
      if (!hosts.has(oh)) return { ok: false, status: 403, error: 'cross-origin request denied' };
    }
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
