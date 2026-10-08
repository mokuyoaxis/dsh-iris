'use strict';
/** Host 作品目录：两种既有存储保持原样，在展示边界统一过滤、排序与分页。 */
import * as legacy from './artifacts.js';
import { galleryArtifactsForDsh } from './dsh-core-adapter.js';
import { mimeOf } from './media.js';

export function normalizeGalleryQuery(input = {}) {
  const query = { offset: 0, limit: 24, media_type: 'all', source: 'all', kind: 'all', ...input };
  const invalid = () => { throw Object.assign(new Error('作品查询参数无效'), { code: 'IRIS_GALLERY_QUERY_INVALID', statusCode: 400 }); };
  for (const key of Object.keys(query)) if (!['offset', 'limit', 'media_type', 'source', 'kind'].includes(key)) invalid();
  if (!Number.isSafeInteger(query.offset) || query.offset < 0 || !Number.isSafeInteger(query.limit)
      || query.limit < 1 || query.limit > 60) invalid();
  if (!['all', 'image', 'video', 'audio', 'text'].includes(query.media_type)
      || !['all', 'core', 'legacy'].includes(query.source)
      || typeof query.kind !== 'string' || !query.kind.trim() || query.kind.length > 256) invalid();
  return query;
}

export async function workbenchArtifacts(input, options = {}) {
  const query = normalizeGalleryQuery(input);
  const items = [];
  let droppedCore = 0, coreError = '';
  if (query.source !== 'legacy') {
    try {
      const core = await galleryArtifactsForDsh(options);
      droppedCore = core.dropped;
      for (const artifact of core.artifacts) {
        if (artifact.kind === 'host-input') continue;
        items.push({ id: artifact.id, file: artifact.id, mime: artifact.mediaType,
          size: artifact.size, createdAt: artifact.createdAt, source: 'core', kind: artifact.kind,
          digest: artifact.digest.value, url: '/iris/api/core/artifact/' + artifact.id + '/media' });
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      coreError = error.code || 'IRIS_GALLERY_CORE_UNAVAILABLE';
    }
  }
  if (query.source !== 'core') {
    for (const item of legacy.all()) items.push({ id: item.id, file: item.file, mime: item.mime || mimeOf(item.file),
      size: Number(item.size || 0), createdAt: item.createdAt || '', source: 'legacy', kind: 'legacy-output', url: legacy.artifactUrl(item) });
  }
  const candidates = items.filter(item => query.media_type === 'all'
    || (query.media_type === 'text' ? item.mime.startsWith('text/') || item.mime === 'application/json'
      : item.mime.startsWith(query.media_type + '/')));
  const kinds = [...new Set(candidates.map(item => item.kind))].sort();
  const matches = candidates.filter(item => query.kind === 'all' || item.kind === query.kind)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.source + ':' + a.id).localeCompare(b.source + ':' + b.id));
  const offset = matches.length ? Math.min(query.offset, Math.floor((matches.length - 1) / query.limit) * query.limit) : 0;
  return { total: matches.length, offset, limit: query.limit, kinds,
    counts: { core: matches.filter(item => item.source === 'core').length, legacy: matches.filter(item => item.source === 'legacy').length },
    droppedCore, ...(coreError ? { coreError } : {}), items: matches.slice(offset, offset + query.limit) };
}
