import { ProviderContractError } from './provider-contract.js';
import { readProviderText, PROVIDER_RESPONSE_LIMITS } from './provider-response.js';

function responseError(message) {
  return new ProviderContractError(message, { stage: 'response', category: 'protocol', acceptance: 'unknown' });
}

/** Gemini web gateway's documented non-streaming Markdown audio response. */
export function musicArtifactsFromResponse(body) {
  if (!Array.isArray(body?.choices)) throw responseError('Music 响应缺少 choices');
  const artifacts = [], seen = new Set();
  for (const choice of body.choices) {
    const content = choice?.message?.content;
    if (typeof content !== 'string') continue;
    for (const match of content.matchAll(/data:(audio\/(?:mpeg|wav|x-wav));base64,([A-Za-z0-9+/=]+)/gi)) {
      const data = match[2];
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.toString('base64') !== data) throw responseError('Music 音频 base64 无效');
      if (seen.has(data)) continue;
      seen.add(data);
      artifacts.push({ kind: 'inline-base64', data, mediaType: match[1].toLowerCase() === 'audio/mpeg' ? 'audio/mpeg' : 'audio/wav' });
    }
  }
  if (!artifacts.length) throw responseError('Music 响应没有可交付的 MP3/WAV 音频');
  return artifacts;
}

export async function generateMusic({ key, baseUrl, model, prompt, timeoutMs = 300000, signal }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(String(baseUrl).replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }] })
  });
  const text = await readProviderText(response, { maxBytes: response.ok ? PROVIDER_RESPONSE_LIMITS.mediaJson : PROVIDER_RESPONSE_LIMITS.json });
  let body;
  try { body = JSON.parse(text); }
  catch (error) { if (response.ok) throw responseError('Music 响应不是有效 JSON'); }
  if (!response.ok) {
    const message = String(body?.error?.message || body?.message || `Music HTTP ${response.status}`);
    throw new ProviderContractError(key ? message.replaceAll(key, '[REDACTED]') : message, {
      stage: 'submit', httpStatus: response.status, category: 'provider', acceptance: 'unknown', retryable: response.status === 502
    });
  }
  return musicArtifactsFromResponse(body);
}
