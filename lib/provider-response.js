import { ProviderContractError } from './provider-contract.js';

export const PROVIDER_RESPONSE_LIMITS = Object.freeze({ json: 2 * 1024 * 1024, mediaJson: 128 * 1024 * 1024,
  image: 64 * 1024 * 1024, audio: 128 * 1024 * 1024, transcript: 8 * 1024 * 1024, video: 1024 * 1024 * 1024 });

/** Count decoded response bytes as well as Content-Length: chunked and compressed
 * responses cannot bypass the limit. Iterator cancellation closes the body. */
export async function* boundedProviderBody(response, { maxBytes, stage = 'response', acceptance = 'unknown' }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('供应商响应限额须为正整数字节数');
  const tooLarge = () => Object.assign(new ProviderContractError('供应商响应超过允许的大小（' + maxBytes + ' 字节）', {
    stage, category: 'protocol', acceptance, retryable: false
  }), { code: 'IRIS_PROVIDER_RESPONSE_TOO_LARGE' });
  if (Number(response.headers.get('content-length')) > maxBytes) {
    try { await response.body?.cancel(); } finally { throw tooLarge(); }
  }
  let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw tooLarge();
    yield chunk;
  }
}

export async function readProviderText(response, options) {
  const chunks = []; let size = 0;
  for await (const chunk of boundedProviderBody(response, options)) { chunks.push(chunk); size += chunk.length; }
  return Buffer.concat(chunks, size).toString('utf8');
}
