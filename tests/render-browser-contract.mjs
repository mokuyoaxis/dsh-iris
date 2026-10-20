import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
import { BrowserHtmlRenderer, renderRoot, RenderError } from '../lib/render.js';

useTempDshHome('iris-render-contract');
const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#123456' } }).png().toBuffer();
const dataUrl = 'data:image/png;base64,' + png.toString('base64');
function fixture(overrides = {}, waitMs = 0) {
  const calls = [];
  const browser = {
    async open() { calls.push('open'); return 'isolated-session'; },
    async openUrl() { calls.push('openUrl'); },
    async screenshot() { calls.push('screenshot'); return { dataUrl }; },
    async close(session) { assert.equal(session, 'isolated-session'); calls.push('close'); },
    ...overrides
  };
  return { browser, calls, renderer: new BrowserHtmlRenderer({ browser, waitMs }) };
}
function assertClean() {
  assert.deepEqual(fs.readdirSync(renderRoot()), [], '成功、失败和取消后都不遗留本次 HTML 或 PNG');
}

// 只接受图片数据；不得以返回路径代替数据，也不得把损坏数据存为作品。
for (const result of [undefined, {}, { path: '/private/unrelated.png' }, { dataUrl: '' },
  { dataUrl: 'data:image/jpeg;base64,' + png.toString('base64') },
  { dataUrl: 'data:image/png;base64,' }, { dataUrl: dataUrl + '!' },
  { dataUrl: 'data:image/png;base64,' + Buffer.from('not a PNG').toString('base64') },
  { dataUrl: 'data:image/png;base64,' + png.subarray(0, 8).toString('base64') }]) {
  const { renderer, calls } = fixture({ async screenshot() { return result; } });
  await assert.rejects(renderer.render({ html: '<p>bad screenshot</p>' }), RenderError);
  assert.deepEqual(calls, ['open', 'openUrl', 'close']);
  assertClean();
}
const tooWide = await sharp({ create: { width: 16385, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
for (const result of [
  { dataUrl: 'data:image/png;base64,' + tooWide.toString('base64'), width: 8, height: 6 },
  { dataUrl: 'data:image/png;base64,' + 'A'.repeat(Math.ceil(64 * 1024 * 1024 / 3) * 4 + 4) }
]) {
  const { renderer, calls } = fixture({ async screenshot() { return result; } });
  await assert.rejects(renderer.render({ html: '<p>large</p>' }), /超过/);
  assert.equal(calls.filter(call => call === 'close').length, 1);
  assertClean();
}

// 打开失败没有可关闭的会话；后续失败原样保留错误，已有会话只关闭一次。
for (const step of ['open', 'openUrl', 'screenshot']) {
  const error = Object.assign(new Error('browser operation timed out'), { code: 'BROWSER_TIMEOUT' });
  const { renderer, calls } = fixture({ async [step]() { throw error; } });
  await assert.rejects(renderer.render({ html: '<p>timeout</p>' }), actual => actual === error);
  assert.equal(calls.filter(call => call === 'close').length, step === 'open' ? 0 : 1);
  assertClean();
}
const noClose = fixture();
delete noClose.browser.close;
await assert.rejects(noClose.renderer.render({ html: '<p>incomplete browser</p>' }), /浏览器服务不可用/);
assert.deepEqual(noClose.calls, []);

{
  const primary = new Error('screenshot failed');
  let closeCalls = 0;
  const { renderer } = fixture({
    async screenshot() { throw primary; },
    async close() { closeCalls++; throw new Error('session already closed'); }
  });
  await assert.rejects(renderer.render({ html: '<p>cleanup error</p>' }), actual => actual === primary);
  assert.equal(closeCalls, 1, '清理错误不掩盖原截图错误');
  assertClean();
}

// open() 不接受取消信号；取消在打开期间到达，也必须等取得会话后关闭。
{
  const controller = new AbortController();
  let opened;
  const { renderer, calls } = fixture({ open() { return new Promise(resolve => { opened = resolve; }); } });
  const pending = renderer.render({ html: '<p>cancel open</p>', signal: controller.signal });
  controller.abort();
  opened('isolated-session');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(calls, ['close']);
  assertClean();
}

// 取消必须通过浏览器公开签名的第三参数及时中断导航/截图，不能等其超时。
for (const step of ['openUrl', 'screenshot']) {
  const controller = new AbortController();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const error = Object.assign(new Error('browser canceled'), { name: 'AbortError' });
  const { renderer, calls } = fixture({
    [step](session, request, signal) {
      assert.equal(session, 'isolated-session');
      assert.equal(signal, controller.signal);
      assert(!('signal' in request));
      assert(!('savePath' in request));
      entered();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(error), { once: true }));
    }
  });
  const pending = renderer.render({ html: '<p>cancel operation</p>', signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(pending, actual => actual === error);
  assert.equal(calls.filter(call => call === 'close').length, 1);
  assertClean();
}

// 即使宿主忽略 signal 并返回成功，取消后也不得接受图片或继续后续调用。
for (const step of ['openUrl', 'screenshot']) {
  const controller = new AbortController();
  const { renderer, calls } = fixture({ async [step]() { controller.abort(); return { dataUrl }; } });
  await assert.rejects(renderer.render({ html: '<p>late result</p>', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.filter(call => call === 'close').length, 1);
  if (step === 'openUrl') assert(!calls.includes('screenshot'));
  assertClean();
}

{
  const controller = new AbortController();
  const { renderer, calls } = fixture({ async openUrl() { setTimeout(() => controller.abort(), 5); } }, 10000);
  await assert.rejects(renderer.render({ html: '<p>cancel render wait</p>', signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(calls, ['open', 'close']);
  assertClean();
}
console.log('ALL OK —— 浏览器 PNG 契约、坏返回/尺寸限制、错误原样保留、取消与会话/临时目录清理');
