import assert from 'node:assert/strict';
import * as adapters from '../lib/adapters.js';
import { dashscopeApiBase, inferMediaProtocol, isDashScopeBaseUrl } from '../lib/provider-protocol.js';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-protocol-security');

const official = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
assert.equal(isDashScopeBaseUrl(official), true);
assert.equal(isDashScopeBaseUrl('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'), true);
assert.equal(isDashScopeBaseUrl('http://dashscope.aliyuncs.com/compatible-mode/v1'), false);
assert.equal(isDashScopeBaseUrl('https://dashscope.aliyuncs.com.evil.example/v1'), false);
assert.equal(inferMediaProtocol(official), 'dashscope');
assert.equal(inferMediaProtocol('https://api.example.com/v1'), 'openai-images');
assert.equal(dashscopeApiBase(official), 'https://dashscope.aliyuncs.com/api/v1');

const config = await import('../lib/config.js');
const compatible = config.upsert({ name: 'compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'fixture', enabled: true });
const dashscope = config.upsert({ name: 'dashscope', baseUrl: official, apiKey: 'fixture', enabled: true });
assert.equal(compatible.mediaProtocol, 'openai-images', '第三方新配置安全推断为 OpenAI Images');
assert.equal(dashscope.mediaProtocol, 'dashscope', '官方地址推断为 DashScope');

let fetchCalls = 0;
const originalFetch = global.fetch;
global.fetch = async () => { fetchCalls++; throw new Error('不应发出请求'); };
try {
  await assert.rejects(
    adapters.submitImage({ key: 'secret', baseUrl: 'https://api.example.com/v1', model: 'wan2.5-t2i-preview', prompt: 'x' }),
    /已阻止发送 API Key/
  );
  await assert.rejects(
    adapters.submitImage({ key: 'secret', baseUrl: 'http://dashscope.aliyuncs.com/v1', model: 'wan2.5-t2i-preview', prompt: 'x' }),
    /只允许使用阿里云官方 HTTPS/
  );
  assert.equal(fetchCalls, 0, '非官方端点必须在 fetch 前拒绝');
} finally {
  global.fetch = originalFetch;
}

console.log('ALL OK —— 媒体协议安全推断 + DashScope API Key 官方 HTTPS 域名绑定通过');
