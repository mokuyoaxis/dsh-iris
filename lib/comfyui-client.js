// Native HTTP transport shared by generation and explicit read-only workflow checks.
import { ProviderContractError } from './provider-contract.js';
import { normalizeMediaEndpoint, providerApiKey, providerMediaBaseUrl } from './provider-protocol.js';

export function comfyFail(message, stage, category = 'protocol', acceptance = stage === 'validate' ? 'not_accepted' : 'accepted', details = {}) {
  throw new ProviderContractError(message, { stage, category, acceptance, ...details });
}
async function bounded(response, limit, stage) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); comfyFail('ComfyUI 响应超过大小上限', stage, 'protocol', stage === 'submit' ? 'unknown' : stage === 'validate' ? 'not_accepted' : 'accepted'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) comfyFail('ComfyUI 响应超过大小上限', stage, 'protocol', stage === 'submit' ? 'unknown' : stage === 'validate' ? 'not_accepted' : 'accepted');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
export function createComfyUiClient(provider, { fetchPort = globalThis.fetch } = {}) {
  const base = normalizeMediaEndpoint(providerMediaBaseUrl(provider)), key = providerApiKey(provider);
  const route = leaf => base + '/' + leaf;
  async function request(url, { method = 'GET', value, signal, stage, timeoutMs = 15000, binary = false } = {}) {
    const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await fetchPort(url, { method, signal: combined, redirect: 'error',
        headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), ...(value ? { 'Content-Type': 'application/json' } : {}) },
        ...(value ? { body: JSON.stringify(value) } : {}) });
    } catch (error) {
      comfyFail('ComfyUI 服务通信失败，请核对原任务与服务状态', stage,
        error.name === 'AbortError' ? 'aborted' : error.name === 'TimeoutError' ? 'timeout' : 'network',
        stage === 'submit' ? 'unknown' : stage === 'validate' ? 'not_accepted' : 'accepted');
    }
    if (!response.ok) {
      await response.body?.cancel();
      const rejection = method === 'POST' && [400, 401, 403, 404, 422, 429].includes(response.status);
      comfyFail('ComfyUI 请求未通过，请核对服务状态与 API 工作流', stage,
        response.status === 401 || response.status === 403 ? 'authentication' : 'provider',
        stage === 'validate' ? 'not_accepted' : method === 'POST' ? rejection ? 'not_accepted' : 'unknown' : 'accepted', { httpStatus: response.status });
    }
    let bytes;
    try { bytes = await bounded(response, binary ? 64 * 1024 * 1024 : 2 * 1024 * 1024, stage); }
    catch (error) {
      if (error instanceof ProviderContractError) throw error;
      comfyFail('ComfyUI 响应读取中断', stage, 'network', stage === 'submit' ? 'unknown' : stage === 'validate' ? 'not_accepted' : 'accepted');
    }
    if (binary) return bytes;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (_) { comfyFail('ComfyUI 返回了无法识别的响应', stage, 'protocol', stage === 'submit' ? 'unknown' : stage === 'validate' ? 'not_accepted' : 'accepted'); }
  }
  return Object.freeze({ route, request });
}
