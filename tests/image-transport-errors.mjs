import assert from 'node:assert/strict';
import * as transport from '../lib/adapters.js';
import {
  createDashScopeProviderAdapter, createOpenAiImagesProviderAdapter,
  createOpenAiChatImagesProviderAdapter, createOpenAiResponsesImagesProviderAdapter
} from '../lib/provider-adapters.js';
import { invokeProviderOperation } from '../lib/provider-adapter.js';

const dashProvider = { id: 'dash-errors', apiKey: 'sk-fixture-private-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' };
const compatibleProvider = { id: 'compatible-errors', auth: 'none', baseUrl: 'https://gateway.invalid/v1' };
const cases = [
  ['DashScope sync', createDashScopeProviderAdapter(dashProvider), 'qwen-image-2.0-pro'],
  ['DashScope async', createDashScopeProviderAdapter(dashProvider), 'wan2.2-t2i-flash'],
  ['Images', createOpenAiImagesProviderAdapter(compatibleProvider), 'image-fixture'],
  ['Chat', createOpenAiChatImagesProviderAdapter(compatibleProvider), 'image-fixture'],
  ['Responses', createOpenAiResponsesImagesProviderAdapter(compatibleProvider), 'image-fixture']
];
const originalFetch = global.fetch;
let calls = 0;
let respond;
global.fetch = async () => { calls++; return respond(); };
const submit = (adapter, model, input = {}) => invokeProviderOperation(adapter, 'submit', {
  capability: 'image', model, input: { prompt: 'offline diagnostic fixture', ...input }
});
const brokenResponse = (error, status = 200) => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode('{"output":')); },
  pull(controller) { controller.error(error); }
}), { status, headers: { 'Content-Type': 'application/json' } });

try {
  for (const size of ['100x100', '4096x4096']) {
    calls = 0;
    respond = () => { throw new Error('local validation must precede fetch'); };
    const result = await submit(cases[0][1], cases[0][2], { size });
    assert.equal(calls, 0, size + ': local rejection sends no HTTP');
    assert.equal(result.kind, 'not_accepted');
    assert.equal(result.error.stage, 'validate');
    assert.equal(result.error.category, 'invalid_request');
    assert.equal(result.error.acceptance, 'not_accepted');
  }

  const failures = [
    ['ENOTFOUND', 'network', /DNS 未找到/],
    ['EAI_AGAIN', 'network', /DNS 解析/],
    ['ECONNREFUSED', 'network', /连接被拒绝/],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout', /连接建立超时/],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout', /等待响应头超时/],
    ['ETIMEDOUT', 'timeout', /网络操作超时/],
    ['ECONNRESET', 'network', /连接被重置/],
    ['CERT_HAS_EXPIRED', 'network', /TLS 证书/]
  ];
  for (const [label, adapter, model] of cases) {
    for (const [code, category, message] of failures) {
      calls = 0;
      respond = () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('fixture'), { code }) }); };
      const result = await submit(adapter, model);
      assert.equal(result.kind, 'acceptance_unknown', label + ': no acceptance inference from transport code');
      assert.equal(result.error.stage, 'submit');
      assert.equal(result.error.category, category);
      assert.equal(result.error.providerCode, code);
      assert.match(result.error.safeMessage, message);
      assert.match(result.error.safeMessage, /尚未收到响应头/);
      assert.equal(calls, 1, label + ': no automatic POST retry');
      assert.equal('rootCause' in result.error, false);
    }

    for (const status of [200, 401]) {
      calls = 0;
      respond = () => brokenResponse(new TypeError('terminated', {
        cause: Object.assign(new Error('fixture socket closed'), { code: 'UND_ERR_SOCKET' })
      }), status);
      const result = await submit(adapter, model);
      assert.equal(result.kind, 'acceptance_unknown', label + ': incomplete body remains unknown');
      assert.equal(result.error.stage, 'response');
      assert.equal(result.error.category, 'network');
      assert.equal(result.error.providerCode, 'UND_ERR_SOCKET');
      assert.match(result.error.safeMessage, new RegExp('已收到 HTTP ' + status + ' 响应头'));
      assert.match(result.error.safeMessage, /读取响应正文失败/);
      assert.equal(calls, 1);
    }

    calls = 0;
    respond = () => brokenResponse(new TypeError('terminated', {
      cause: Object.assign(new Error('fixture body timeout'), { code: 'UND_ERR_BODY_TIMEOUT' })
    }));
    const bodyTimeout = await submit(adapter, model);
    assert.equal(bodyTimeout.kind, 'acceptance_unknown');
    assert.equal(bodyTimeout.error.stage, 'response');
    assert.equal(bodyTimeout.error.category, 'timeout');
    assert.equal(bodyTimeout.error.providerCode, 'UND_ERR_BODY_TIMEOUT');
    assert.match(bodyTimeout.error.safeMessage, /响应正文读取超时/);
    assert.equal(calls, 1);

    for (const error of [
      Object.assign(new Error('fixture cancellation'), { code: 'ABORT_ERR' }),
      new DOMException('fixture cancellation', 'AbortError'),
      new DOMException('fixture timeout', 'TimeoutError')
    ]) {
      for (const phase of ['fetch', 'body']) {
        calls = 0;
        respond = () => { if (phase === 'fetch') throw error; return brokenResponse(error); };
        const result = await submit(adapter, model);
        assert.equal(result.kind, 'acceptance_unknown');
        assert.equal(result.error.category, error.name === 'TimeoutError' ? 'timeout' : 'aborted', label + ': ' + phase);
        assert.equal(calls, 1);
      }
    }

    for (const [status, code, message, category, kind] of [
      [401, 'InvalidApiKey', 'credential validation timed out', 'authentication', 'not_accepted'],
      [403, 'AccessDenied', 'access denied', 'authentication', 'not_accepted'],
      [429, 'Throttling', 'rate limited', 'rate_limit', 'not_accepted'],
      [429, 'BudgetLimitExceeded', 'budget exceeded', 'quota', 'not_accepted'],
      [400, 'InvalidParameter', 'unsupported timeout parameter', 'invalid_request', 'not_accepted'],
      [500, 'InternalError', 'upstream failed', 'provider', 'acceptance_unknown']
    ]) {
      calls = 0;
      respond = () => new Response(JSON.stringify({ code, message }), { status });
      const result = await submit(adapter, model);
      assert.equal(result.kind, kind, label + ': HTTP ' + status);
      assert.equal(result.error.category, category);
      assert.equal(result.error.httpStatus, status);
      assert.equal(result.error.providerCode, code);
      assert.equal(calls, 1);
    }

    respond = () => new Response('malformed json', { status: 200 });
    const malformed = await submit(adapter, model);
    assert.equal(malformed.kind, 'acceptance_unknown');
    assert.equal(malformed.error.category, 'protocol', label + ': malformed JSON is not network');
  }

  const cancellation = Object.assign(new Error('fixture cancellation'), { code: 'ABORT_ERR' });
  respond = () => { throw cancellation; };
  await assert.rejects(transport.generateImageMultimodal({
    key: 'k', baseUrl: dashProvider.baseUrl, model: 'qwen-image-2.0-pro', prompt: 'fixture'
  }), error => error === cancellation, 'ABORT_ERR preserves the original error');
} finally {
  global.fetch = originalFetch;
}

console.log('ALL OK —— 五条生图路径的尺寸未受理、连接/正文诊断、取消/超时与 HTTP 分类通过（零外部请求）');
