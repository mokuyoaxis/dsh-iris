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

// C-9 回归：脱敏必须覆盖【带厂商前缀】的凭据参数名。
// 旧正则要求参数名紧跟 ?/&，导致 OSSAccessKeyId / X-Amz-Credential / security-token 等漏网。
{
  const { redactProviderMessage } = await import('../lib/provider-contract.js');
  const prefixCases = [
    ['OSSAccessKeyId', 'https://b.oss.aliyuncs.com/x?OSSAccessKeyId=LTAI5tSECRETVAL&Expires=1'],
    ['Signature', 'https://b.oss.aliyuncs.com/x?Signature=abcSECRETVAL&Expires=1'],
    ['security-token', 'https://x.com/a?access_key=AKIA&security-token=TOKSECRETVAL'],
    ['X-Amz-Credential', 'https://s3.amazonaws.com/b/x?X-Amz-Credential=AKIASECRETVAL&X-Amz-Date=1'],
    ['X-Amz-Signature', 'https://s3.amazonaws.com/b/x?X-Amz-Signature=deadSECRETVAL'],
    ['x-oss-signature', 'https://x.com/a?x-oss-signature=sigSECRETVAL']
  ];
  for (const [name, url] of prefixCases) {
    const out = redactProviderMessage(url);
    assert.ok(!/SECRETVAL/.test(out), `带前缀凭据参数 ${name} 必须脱敏：${out}`);
  }
  // 冒号/分号分隔的 JSON 风格也必须覆盖（X-Amz-Credential 常出现在结构化错误里）
  const structured = redactProviderMessage('{"X-Amz-Credential":"AKIASECRETVAL","X-Amz-Signature":"deadSECRETVAL"}');
  assert.ok(!/SECRETVAL/.test(structured), '结构化凭据字段必须脱敏：' + structured);
  // 不得误伤正常文本
  assert.equal(redactProviderMessage('正常的中文错误信息'), '正常的中文错误信息', '不得误伤正常文本');
  const plain = 'token 数量不足'; // 无 = 号，不是凭据赋值
  assert.equal(redactProviderMessage(plain), plain, '不含 = 的 token 字样不得误脱敏');

  // C-9 首版修复的回归守卫：首版给强/弱凭据词都开了无限 `[a-z0-9_-]*` 后缀，
  // 导致「含关键字 + 有等号、但不是凭据」的参数被误脱敏，诊断信息丢失。
  // 上面两条旧断言（无等号、纯中文）恰好绕开了正则命中条件，抓不到这一类，故补此表。
  const benignCases = [
    ['page_token', '分页游标'], ['next_token', '分页游标'],
    ['tokenizer', '分词器名'], ['max_tokens', '长度上限'],
    ['signature_mode', '模式开关'], ['signature_version', '版本号'],
    ['api_version', 'API 版本'], ['key_id', '非密鑰标识'],
    ['authorized_by', '操作者'], ['top_k', '采样参数'],
    ['monkey', '无关参数'], ['keywords', '无关参数']
  ];
  for (const [name, why] of benignCases) {
    const input = 'https://x.com/a?' + name + '=PLAINVAL&limit=10';
    const out = redactProviderMessage(input);
    assert.ok(out.includes('PLAINVAL'),
      `非凭据参数 ${name}（${why}）不得被脱敏，否则诊断信息丢失：${out}`);
  }

  // 反向确认：强凭据词仍允许任意厂商前缀（含驼峰），不得因收紧后缀而漏网。
  const strongCases = [
    'OSSAccessKeyId', 'AccessKeySecret', 'X-Amz-Credential', 'X-Amz-Signature',
    'x-oss-signature', 'gemini-signature', 'Signature', 'apikey', 'secret', 'credential'
  ];
  for (const name of strongCases) {
    const out = redactProviderMessage('https://x.com/a?' + name + '=SECRETVAL');
    assert.ok(!/SECRETVAL/.test(out), `强凭据词 ${name} 必须脱敏：${out}`);
  }
  // 弱凭据词：厂商前缀 + 有限后缀仍须脱敏
  for (const name of ['token', 'security-token', 'X-Amz-Security-Token', 'refresh_token', 'access_token']) {
    const out = redactProviderMessage('https://x.com/a?' + name + '=SECRETVAL');
    assert.ok(!/SECRETVAL/.test(out), `弱凭据词 ${name}（厂商前缀）必须脱敏：${out}`);
  }
}

console.log('ALL OK —— 媒体协议安全推断 + DashScope API Key 官方 HTTPS 域名绑定 + 带前缀凭据脱敏（C-9）通过');
