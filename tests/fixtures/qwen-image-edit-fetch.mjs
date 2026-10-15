/** CLI 原生 Qwen 编辑协议 fixture；任何其他网络请求均明确失败。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';

const output = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#0f0' } }).png().toBuffer();
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.href === 'https://artifact.fixture.invalid/qwen.png') return new Response(output, { headers: { 'Content-Type': 'image/png' } });
  assert.equal(url.href, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(options.method, 'POST');
  assert.equal(new Headers(options.headers).get('authorization'), 'Bearer qwen-fixture-key');
  const body = JSON.parse(options.body), content = body.input.messages[0].content;
  assert.equal(body.model, 'qwen-image-edit-max');
  assert.equal(body.input.messages[0].role, 'user');
  assert.equal(content.length, 2); assert.match(content[0].image, /^data:image\/png;base64,/);
  assert.equal(content[1].text, 'change red to green');
  assert.equal(body.parameters.n, 1); assert.equal(body.parameters.size, '1024*1024');
  const bytes = Buffer.from(content[0].image.split(',')[1], 'base64');
  const metadata = await sharp(bytes).metadata();
  fs.appendFileSync(process.env.IRIS_QWEN_FIXTURE_STATE, JSON.stringify({ path: url.pathname, width: metadata.width,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') }) + '\n');
  return Response.json({ output: { choices: [{ message: { content: [{ image: 'https://artifact.fixture.invalid/qwen.png' }] } }] } });
};
