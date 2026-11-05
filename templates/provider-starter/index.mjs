import * as iris from '@mokuyoaxis/dsh-iris/plugins';
import { writeFileSync } from 'node:fs';

if (iris.PROVIDER_FACTORY_CONTEXT_VERSION !== 1 || typeof iris.ProviderContractError !== 'function') {
  throw new Error('Wan Provider starter requires Iris Provider factory context v1. Published 0.3.0-alpha.1 does not include it; use the verified newer Core candidate described in README.');
}
const { definePlugin, defineProviderAdapter, ProviderContractError, normalizeMediaEndpoint } = iris;
export const PROVIDER_PROTOCOL = 'example.wan-image.images';
export const SUPPORTED_MODEL = 'wan2.6-t2i';
const JSON_LIMIT = 1024 * 1024, IMAGE_LIMIT = 8 * 1024 * 1024, DIRECTORY_LIMIT = 1000;

function failure(message, stage, acceptance, category = 'protocol', details = {}) {
  return new ProviderContractError(message, { stage, acceptance, category, ...details });
}
function endpoint(value) {
  const base = normalizeMediaEndpoint(value);
  if (/\/(?:api\/v1|compatible-mode\/v1)$/.test(new URL(base).pathname)) {
    throw failure('Use the workspace API root, without /api/v1 or /compatible-mode/v1.', 'validate', 'not_accepted', 'invalid_request');
  }
  return base;
}
function boundedSignal(request) {
  const deadline = AbortSignal.timeout(request.timeoutMs ?? 30000);
  return request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
}
async function readBody(response, limit, stage, acceptance) {
  if (!response.body) throw failure('Response has no body.', stage, acceptance);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        await reader.cancel(); throw failure('Response exceeds the documented starter size limit.', stage, acceptance);
      }
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}
function json(bytes, stage, acceptance) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw failure('Provider response is not valid UTF-8 JSON.', stage, acceptance); }
}
function httpFailure(response, operation) {
  const ambiguous = [408, 409, 425, 499].includes(response.status);
  const known = operation === 'submit' && response.status >= 400 && response.status < 500 && !ambiguous;
  const acceptance = operation === 'submit' ? known ? 'not_accepted' : 'unknown' : operation === 'discover' ? 'not_accepted' : 'accepted';
  const category = [401, 403].includes(response.status) ? 'authentication' : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'provider' : 'invalid_request';
  const error = failure(`Wan HTTP request failed (${response.status}).`, operation === 'discover' ? 'validate' : operation, acceptance, category,
    { httpStatus: response.status, retryable: response.status === 429 || response.status >= 500 });
  if (response.status === 429) {
    const value = response.headers.get('retry-after'), seconds = value && Number(value), date = value && Date.parse(value);
    if (Number.isFinite(seconds) && seconds >= 0) error.retryAfterMs = Math.max(1000, seconds * 1000);
    else if (Number.isFinite(date) && date > Date.now()) error.retryAfterMs = date - Date.now();
  }
  return error;
}

export default definePlugin({
  manifest: { contractVersion: 0, id: 'example.wan-image', version: '0.1.0',
    compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
    contributions: { providers: [{ id: 'images', version: '0.1.0', title: 'Wan 2.6 async image reference', capabilities: ['image-gen'],
      configuration: [{ key: 'baseUrl', type: 'url', label: 'Workspace API root', required: true },
        { key: 'mediaBaseUrl', type: 'url', label: 'Separate media API root', advanced: true },
        { key: 'apiKey', type: 'secret', label: 'API key', required: true }] }] } },
  activate() {
    // No timers, agents or global state to close. Core owns the borrowed network port.
    return { providers: { images: { normalizeEndpoint: endpoint,
      supportsModel: ({ modelId, capability }) => modelId === SUPPORTED_MODEL && capability === 'image-gen',
      supportsImageEdit: () => false,
      createAdapter(provider, context) {
        if (context?.contractVersion !== 1 || typeof context.network?.fetch !== 'function') {
          throw failure('Core must supply Provider factory context v1.', 'validate', 'not_accepted', 'invalid_request');
        }
        const base = endpoint(provider.mediaBaseUrl || provider.baseUrl), key = provider.apiKey || '';
        if (provider.auth !== 'none' && !key) throw failure('Configure an API credential in Core before calling this Provider.', 'validate', 'not_accepted', 'authentication');
        const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) };
        async function api(route, request, operation, payload) {
          const response = await context.network.fetch(base + route, { method: payload === undefined ? 'GET' : 'POST',
            redirect: 'error', signal: boundedSignal(request), headers: { ...headers, ...(operation === 'submit' ? { 'X-DashScope-Async': 'enable' } : {}) },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
          const acceptance = operation === 'submit' ? 'unknown' : operation === 'discover' ? 'not_accepted' : 'accepted';
          const stage = operation === 'discover' ? 'validate' : operation === 'submit' ? 'response' : operation;
          const bytes = await readBody(response, JSON_LIMIT, stage, acceptance);
          if (!response.ok) throw httpFailure(response, operation);
          return json(bytes, stage, acceptance);
        }
        return defineProviderAdapter({ id: provider.id, protocol: PROVIDER_PROTOCOL, capabilities: ['image'], operations: {
          async discover(request = {}) {
            const models = [], seen = new Set(); let total;
            for (let page = 1; page <= 10; page++) {
              const value = await api(`/api/v1/models?capabilities=IG&page_no=${page}&page_size=100`, request, 'discover');
              const output = value?.output;
              if (!output || !Array.isArray(output.models) || output.models.length > 100 || !Number.isSafeInteger(output.total)
                  || output.total < 0 || output.total > DIRECTORY_LIMIT || output.page_no !== page || output.page_size !== 100
                  || total !== undefined && total !== output.total) throw failure('Model directory pagination is invalid or changed; keep the previous complete snapshot.', 'validate', 'not_accepted');
              total = output.total;
              for (const model of output.models) {
                if (!model || typeof model.model !== 'string' || !model.model || seen.has(model.model)) throw failure('Model directory contains invalid or duplicate IDs.', 'validate', 'not_accepted');
                seen.add(model.model);
                if (model.model === SUPPORTED_MODEL) models.push({ id: model.model, capabilities: ['image-gen'] });
              }
              if (seen.size === total) return { models };
              if (!output.models.length || seen.size > total) throw failure('Model directory is incomplete.', 'validate', 'not_accepted');
            }
            throw failure('Model directory exceeded the bounded page count.', 'validate', 'not_accepted');
          },
          async submit(request) {
            const { input } = request;
            if (request.capability !== 'image' || request.model !== SUPPORTED_MODEL || input.image !== undefined) {
              throw failure('This reference supports only Wan 2.6 text-to-image; image editing and other models are unsupported.', 'validate', 'not_accepted', 'invalid_request');
            }
            if (typeof input.prompt !== 'string' || !input.prompt.trim() || Array.from(input.prompt).length > 2100
                || input.n !== undefined && (!Number.isSafeInteger(input.n) || input.n < 1 || input.n > 4)
                || input.size !== undefined && (typeof input.size !== 'string' || !/^\d+[x*]\d+$/i.test(input.size))) {
              throw failure('Use a nonempty prompt of at most 2100 characters, n=1–4 and an optional width*height size.', 'validate', 'not_accepted', 'invalid_request');
            }
            const value = await api('/api/v1/services/aigc/image-generation/generation', request, 'submit', { model: request.model,
              input: { messages: [{ role: 'user', content: [{ text: input.prompt }] }] },
              parameters: { n: input.n ?? 1, ...(input.size ? { size: input.size.replace(/x/i, '*') } : {}) } });
            if (typeof value?.output?.task_id !== 'string' || !value.output.task_id.trim()) throw failure('Submission response has no remote task ID; acceptance remains unknown.', 'response', 'unknown');
            return { kind: 'accepted', remoteTaskId: value.output.task_id };
          },
          async poll(request) {
            const value = await api('/api/v1/tasks/' + encodeURIComponent(request.remoteTaskId), request, 'poll'), output = value?.output;
            if (['PENDING', 'RUNNING'].includes(output?.task_status)) return { kind: 'pending', progress: output.task_status };
            if (output?.task_status === 'SUCCEEDED') {
              if (!Array.isArray(output.choices) || output.choices.some(choice => !Array.isArray(choice?.message?.content)
                  || choice.message.content.some(item => !item || typeof item !== 'object'))) {
                throw failure('Successful task response contains malformed image choices.', 'poll', 'accepted');
              }
              const images = output.choices.flatMap(choice => choice.message.content).flatMap(item => typeof item.image === 'string' && item.image ? [item.image] : []);
              if (!images?.length || images.length > 4) throw failure('Successful task response has no usable image results.', 'poll', 'accepted');
              return { kind: 'succeeded', artifacts: images.map(url => ({ kind: 'remote-url', url, mediaType: 'image/png' })) };
            }
            const kind = { FAILED: 'failed', CANCELED: 'canceled', UNKNOWN: 'unknown' }[output?.task_status];
            if (kind) return { kind, error: failure('Remote task is ' + kind + '.', 'poll', 'accepted', kind === 'canceled' ? 'aborted' : kind === 'unknown' ? 'unknown' : 'provider') };
            throw failure('Remote task response has an unrecognized status.', 'poll', 'accepted');
          },
          async download(request) {
            if (request.artifact.kind !== 'remote-url') throw failure('Wan result must be a remote image URL.', 'download', 'accepted');
            const url = new URL(request.artifact.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('Result URL must use HTTP(S) without embedded credentials.', 'download', 'accepted');
            // Presigned CDN URLs never receive the API Authorization header. Redirects use the same Core port.
            const response = await context.network.fetch(url, { signal: boundedSignal(request) });
            const bytes = await readBody(response, IMAGE_LIMIT, 'download', 'accepted');
            if (!response.ok) throw httpFailure(response, 'download');
            writeFileSync(request.targetPath, bytes, { mode: 0o600, flag: 'wx' });
            return { bytes: bytes.length };
          },
          mapError(error, defaults = {}) {
            if (error instanceof ProviderContractError) return error;
            const aborted = error?.name === 'AbortError', timeout = error?.name === 'TimeoutError';
            return failure('Wan transport or local delivery failed; inspect the original Core Task before taking another action.',
              error?.stage || defaults.stage || 'submit', error?.acceptance || defaults.acceptance || 'unknown',
              error?.category || (aborted ? 'aborted' : timeout ? 'timeout' : ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EEXIST'].includes(error?.code) ? 'local_io' : 'network'),
              { ...(typeof error?.code === 'string' && error.code.startsWith('IRIS_') ? { providerCode: error.code } : {}), retryable: aborted ? false : true });
          }
        }, unsupported: { cancel: 'Remote cancellation is outside this reference; stopping Core waiting does not cancel billing.' },
        unsupportedPreparation: 'This text-to-image protocol does not upload source images.' });
      }
    } } };
  }
});
