// Same-origin transport. Media stays GET-only; owner writes have a finite management path.
export class WorkbenchHttpError extends Error {
  constructor(status, error) {
    super(error?.message || '本地服务返回了无法读取的响应');
    this.name = 'WorkbenchHttpError'; this.status = status;
    this.code = error?.code; this.requestId = error?.requestId;
  }
}

export function createReadClient(token, { onUnauthorized = () => {} } = {}) {
  const lifetime = new AbortController(), queue = [];
  let active = 0;
  function drain() {
    while (active < 2 && queue.length) {
      const job = queue.shift(); active++;
      run(job).then(job.resolve, job.reject).finally(() => { active--; drain(); });
    }
  }
  async function run({ pathname, binary, download, signal, value, method = 'GET' }) {
    const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    const response = await fetch(pathname, { method, headers: { Authorization: 'Bearer ' + token,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: combined,
      ...(method === 'POST' ? { body: JSON.stringify(value) } : {}) });
    if (!response.ok) {
      const body = await response.json();
      const error = new WorkbenchHttpError(response.status, body.error);
      if (response.status === 401 && !lifetime.signal.aborted) onUnauthorized();
      throw error;
    }
    if (download) return { blob: await response.blob(), filename: /^attachment; filename="([^"]+)"$/.exec(response.headers.get('content-disposition') || '')?.[1] };
    return binary ? response.blob() : response.json();
  }
  return Object.freeze({
    get(pathname, { binary = false, download = false, signal } = {}) {
      if (!/^\/api\/v0\//.test(pathname) || pathname.includes('#')) throw new TypeError('仅允许本地 API 路径');
      return new Promise((resolve, reject) => { queue.push({ pathname, binary, download, signal, resolve, reject }); drain(); });
    },
    postManagement(pathname, value) {
      if (!/^\/api\/v0\/connection-management\/(?:templates|connections(?:\/[a-f0-9-]{36}\/(?:update|revoke|export|skill))?)$/.test(pathname)) {
        throw new TypeError('仅允许连接管理操作');
      }
      return new Promise((resolve, reject) => { queue.push({ pathname, value, method: 'POST', resolve, reject }); drain(); });
    },
    close() { lifetime.abort(); }
  });
}
