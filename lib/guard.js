'use strict';
/**
 * Iris 请求守卫（O2 授权边界，2026-09-03 修订为"发布安全优先"）。
 *
 * 调研宿主结论：DSH 在 `dsh-client-connection` 里有一套权威信任栅栏
 * `isTrustedApiRequest`（回环∪trustedHosts + Sec-Fetch-Site + Origin==Host），
 * 但它**只挂在 `/api` 前缀**。iris 注册的是 `/iris/*` 裸 prefix 路由，在栅栏之外，
 * 所以 iris 需自备一道——但必须**对齐宿主里"永不锁死合法用户"的那半，
 * 舍弃"会锁死 LAN/反代用户"的那半**。
 *
 * 威胁与处置（按发布安全排序）：
 * ① 驱动式 CSRF（真实、高价值）：恶意网页对 `/iris/api/actions/*` 发跨站 POST，
 *    触发付费生成/写盘。→ **挡**：POST 时 `Sec-Fetch-Site === cross-site` 拒绝；
 *    有 `Origin` 且 `Origin.host !== 请求 Host` 拒绝。合法同源用户（不管在回环/LAN/
 *    反代域名上访问，浏览器 Origin 总与 Host 同源）永不误伤；无 Origin 的 CLI/curl 放行。
 * ② DNS 重绑定读 state / 驱动 POST（低价值）：需要 Host 白名单才能挡，但白名单正是
 *    锁死 LAN/反代用户的元凶。用户裁定：iris 开源、反代场景无所谓 → **不挡**，
 *    读接口（GET/HEAD/SSE）完全放开（跨源读本就受 CORS 阻挡，媒体另有 token 能力凭证）。
 *
 * 净效果：**任何部署拓扑都不拦合法用户**，只挡跨站 CSRF 驱动付费动作。
 */

/** 请求 Host 头 → host:port 规范化（小写，去 IPv6 方括号保留） */
function authority(header) {
  const h = String(header || '').trim().toLowerCase();
  if (!h) return '';
  return h;
}

/**
 * 纯函数裁决：{ok:true} 放行；否则 {ok:false, status, error}。
 * 非 POST 一律放行；POST 仅挡跨站/跨源（同源浏览器与无 Origin 的 CLI 放行）。
 * @param {{method?:string, headers?:object}} req node:http IncomingMessage 的最小面
 */
export function checkRequest(req) {
  const headers = req.headers || {};
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'POST') return { ok: true }; // 读接口放开：跨源读受 CORS 挡，媒体有 token

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
  return { ok: true }; // 同源浏览器，或无 Origin 的本机 CLI/curl
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
