// Same-origin transport. Writes use named media methods or a finite management path.
const RUN = /^run_[a-f0-9]{24}$/, ARTIFACT = /^artifact_[a-f0-9]{24}$/, OPERATION = /^op_[a-f0-9]{64}$/;
const KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function id(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError('本地操作标识无效'); return value; }
export class WorkbenchHttpError extends Error {
  constructor(status, error) {
    super(error?.message || '本地服务返回了无法读取的响应');
    this.name = 'WorkbenchHttpError'; this.status = status;
    this.code = error?.code; this.requestId = error?.requestId;
  }
}

export async function redeemLoginLink(ticket, signal) {
  const response = await fetch('/api/v0/workbench/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }),
    credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  const value = await response.json();
  if (!response.ok) throw new WorkbenchHttpError(response.status, value.error);
  if (value.contractVersion !== 0 || typeof value.accessToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.accessToken)) throw new TypeError('不支持的登录响应');
  return value.accessToken;
}

export function createReadClient(token, { onUnauthorized = () => {} } = {}) {
  const lifetime = new AbortController(), reads = [], media = [];
  let active = 0;
  function drain() {
    while (active < 2 && (reads.length || media.length)) {
      const job = (reads.length ? reads : media).shift(); active++;
      run(job).then(job.resolve, job.reject).finally(() => { active--; drain(); });
    }
  }
  async function run({ pathname, binary, download, signal, value, body, key, method = 'GET', mediaType = 'application/json', timeoutMs = 15000 }) {
    const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    const response = await fetch(pathname, { method, headers: { Authorization: 'Bearer ' + token,
      ...(method === 'POST' ? { 'Content-Type': mediaType } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: combined,
      ...(method === 'POST' ? { body: body ?? JSON.stringify(value) } : {}) });
    if (!response.ok) {
      const body = await response.json();
      const error = new WorkbenchHttpError(response.status, body.error);
      if (response.status === 401 && !lifetime.signal.aborted) onUnauthorized();
      throw error;
    }
    if (download) return { blob: await response.blob(), filename: /^attachment; filename="([^"]+)"$/.exec(response.headers.get('content-disposition') || '')?.[1] };
    return binary ? response.blob() : response.json();
  }
  function get(pathname, { binary = false, download = false, signal } = {}) {
    if (!/^\/api\/v0\//.test(pathname) || pathname.includes('#')) throw new TypeError('仅允许本地 API 路径');
    if (lifetime.signal.aborted) return Promise.reject(lifetime.signal.reason);
    return new Promise((resolve, reject) => { (binary || download ? media : reads).push({ pathname, binary, download, signal, resolve, reject }); drain(); });
  }
  const post = (pathname, value, options = {}) => run({ pathname, value, method: 'POST', ...options });
  return Object.freeze({
    get,
    callPlugin({ key, ...value }, { signal } = {}) { return post('/api/v0/plugin-operations', value, { key: id(key, KEY), signal }); },
    lookupCreation(kind, key, options) {
      if (!['image-import', 'flow-create', 'generation-create', 'video-create', 'audio-import', 'speech-create', 'transcription-create', 'vision-create', 'ocr-create', 'locate-create', 'summarize-create'].includes(kind)) throw new TypeError('创建类型无效');
      return get('/api/v0/creation-requests?' + new URLSearchParams({ kind, key: id(key, KEY) }), options);
    },
    listInbox({ kind, limit } = {}, options) {
      const params = new URLSearchParams();
      if (kind !== undefined) params.set('kind', kind);
      if (limit !== undefined) params.set('limit', String(limit));
      const qs = params.toString();
      return get('/api/v0/inbox' + (qs ? '?' + qs : ''), options);
    },
    importInboxFile(name, { key, signal } = {}) {
      if (typeof name !== 'string' || !name.length || name.length > 255) throw new TypeError('收件文件名无效');
      return post('/api/v0/inbox/import', { name }, { key: id(key, KEY), signal });
    },
    lookupOperation(key, options) { return get('/api/v0/operations?' + new URLSearchParams({ key: id(key, KEY) }), options); },
    getOperation(operationId, options) { return get('/api/v0/operations/' + id(operationId, OPERATION), options); },
    getRun(runId, options) { return get('/api/v0/runs/' + id(runId, RUN), options); },
    getRunLineage(runId, options) { return get('/api/v0/runs/' + id(runId, RUN) + '/lineage', options); },
    listArtifacts({ kind = 'image', limit = 50, offset = 0 } = {}, options) {
      const params = new URLSearchParams({ kind, limit: String(limit), offset: String(offset) });
      return get('/api/v0/artifacts?' + params.toString(), options);
    },
    getArtifactMeta(artifactId, options) { return get('/api/v0/artifacts/' + id(artifactId, ARTIFACT) + '/meta', options); },
    getArtifactLineage(artifactId, options) { return get('/api/v0/artifacts/' + id(artifactId, ARTIFACT) + '/lineage', options); },
    uploadImage(image, { key, signal } = {}) {
      if (!(image instanceof Blob) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.type)) throw new TypeError('需要 PNG/JPEG/WebP 图片字节');
      return post('/api/v0/images', undefined, { body: image, mediaType: image.type, key: id(key, KEY), signal });
    },
    createRun(value, { key, signal } = {}) { return post('/api/v0/runs', value, { key: id(key, KEY), signal }); },
    createVideo(value, { key, signal } = {}) { return post('/api/v0/videos', value, { key: id(key, KEY), signal }); },
    createGeneration(value, { key, signal } = {}) { return post('/api/v0/generations', value, { key: id(key, KEY), signal }); },
    createVision(value, { key, signal } = {}) { return post('/api/v0/visions', value, { key: id(key, KEY), signal }); },
    createOcr(value, { key, signal } = {}) { return post('/api/v0/ocrs', value, { key: id(key, KEY), signal }); },
    createLocate(value, { key, signal } = {}) { return post('/api/v0/locates', value, { key: id(key, KEY), signal }); },
    createSummary(value, { key, signal } = {}) { return post('/api/v0/summaries', value, { key: id(key, KEY), signal }); },
    extractFrames({ artifactId, maxFrames, targetWidth, format }, { signal } = {}) {
      return post('/api/v0/local-media/frames', { artifactId: id(artifactId, ARTIFACT), maxFrames, targetWidth, format }, { signal });
    },
    cropImage(value, { signal } = {}) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).sort().join(',') !== 'artifactId,height,left,top,width'
          || !ARTIFACT.test(value.artifactId)
          || !Number.isSafeInteger(value.left) || value.left < 0
          || !Number.isSafeInteger(value.top) || value.top < 0
          || !Number.isSafeInteger(value.width) || value.width < 1
          || !Number.isSafeInteger(value.height) || value.height < 1) throw new TypeError('裁剪参数无效');
      return post('/api/v0/local-media/crop', value, { signal });
    },
    pixelDiff(value, { signal } = {}) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
          || !ARTIFACT.test(value.imageAArtifactId || '') || !ARTIFACT.test(value.imageBArtifactId || '')
          || Object.keys(value).some(k => !['imageAArtifactId', 'imageBArtifactId', 'grid', 'topRegions'].includes(k))
          || value.grid !== undefined && (!Number.isSafeInteger(value.grid) || value.grid < 1 || value.grid > 64)
          || value.topRegions !== undefined && (!Number.isSafeInteger(value.topRegions) || value.topRegions < 1 || value.topRegions > 100)) {
        throw new TypeError('像素对比参数无效');
      }
      return post('/api/v0/local-media/diff', value, { signal });
    },
    renderHtml(value, { signal } = {}) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).some(k => !['html', 'width', 'height', 'fullPage'].includes(k))
          || typeof value.html !== 'string' || !value.html.trim()
          || new TextEncoder().encode(value.html).byteLength > 1024 * 1024
          || value.width !== undefined && (!Number.isSafeInteger(value.width) || value.width < 1 || value.width > 4096)
          || value.height !== undefined && (!Number.isSafeInteger(value.height) || value.height < 1 || value.height > 4096)
          || value.fullPage !== undefined && typeof value.fullPage !== 'boolean') {
        throw new TypeError('HTML 截图参数无效');
      }
      return post('/api/v0/html-render', value, { signal, timeoutMs: 35000 });
    },
    uploadAudio(audio, { key, signal } = {}) {
      if (!(audio instanceof Blob) || !['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac'].includes(audio.type)) throw new TypeError('需要WAV/MP3/OGG/FLAC音频');
      return post('/api/v0/audio', undefined, { body: audio, mediaType: audio.type, key: id(key, KEY), signal });
    },
    createSpeech(value, { key, signal } = {}) { return post('/api/v0/speeches', value, { key: id(key, KEY), signal }); },
    createTranscription(value, { key, signal } = {}) { return post('/api/v0/transcriptions', value, { key: id(key, KEY), signal }); },
    continueRun(runId, expectedRevision, { key, signal } = {}) {
      return post('/api/v0/runs/' + id(runId, RUN) + '/continue', { expectedRevision }, { key: id(key, KEY), signal });
    },
    stopOperation(operationId, { signal } = {}) { return post('/api/v0/operations/' + id(operationId, OPERATION) + '/cancel', {}, { signal }); },
    selectRun(runId, artifactId, expectedRevision, { signal } = {}) {
      return post('/api/v0/runs/' + id(runId, RUN) + '/selection', { artifactId: id(artifactId, ARTIFACT), expectedRevision }, { signal });
    },
    postManagement(pathname, value) {
      if (!/^\/api\/v0\/connection-management\/(?:templates|connections(?:\/[a-f0-9-]{36}\/(?:update|revoke|delete|export|skill))?)$/.test(pathname)) {
        throw new TypeError('仅允许连接管理操作');
      }
      return post(pathname, value);
    },
    postProvider(action, value, { signal } = {}) {
      if (!['save', 'discover', 'workflow-check', 'policies', 'enabled', 'remove', 'impact', 'check', 'monitor'].includes(action)) throw new TypeError('仅允许明确的供应商管理操作');
      return post('/api/v0/provider-management/' + action, value, { signal });
    },
    postNetwork(action, value, { signal } = {}) {
      if (!['init', 'nodes/add', 'nodes/set', 'nodes/remove', 'pools/add', 'pools/set', 'pools/remove', 'bindings/set', 'bindings/remove', 'probe'].includes(action)) throw new TypeError('仅允许明确的网络管理操作');
      return post('/api/v0/network-management/' + action, value, { signal });
    },
    close() { lifetime.abort(); for (const job of [...reads.splice(0), ...media.splice(0)]) job.reject(lifetime.signal.reason); }
  });
}
