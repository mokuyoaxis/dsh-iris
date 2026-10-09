import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
const jpeg = await sharp({ create: { width: 12, height: 9, channels: 3, background: '#f00' } }).jpeg().toBuffer();
globalThis.fetch = async (input, options = {}) => {
  const url = String(input), body = options.body ? JSON.parse(options.body) : null;
  const authMatches = new Headers(options.headers).get('authorization') === 'Bearer chat-cli-fixture-key';
  const trace = { pathname: new URL(url).pathname, model: body?.model, stream: body?.stream, authMatches };
  if (Array.isArray(body?.messages?.[0]?.content)) {
    const dataUrl = body.messages[0].content[1].image_url.url;
    const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
    trace.inputMediaType = dataUrl.slice(5, dataUrl.indexOf(';'));
    trace.inputWidth = (await sharp(bytes).metadata()).width;
    trace.inputText = body.messages[0].content[0].text;
    trace.imageHashMatches = crypto.createHash('sha256').update(bytes).digest('hex') === crypto.createHash('sha256').update(jpeg).digest('hex');
  }
  fs.appendFileSync(process.env.IRIS_CHAT_FIXTURE_STATE, JSON.stringify(trace) + '\n');
  if (!authMatches) throw new Error('fixture wrong account');
  if (url.endsWith('/chat/completions') && body?.stream === true) return new Response(
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '红色矩形' } }] }) + '\n\n'
    + 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
  if (url.endsWith('/chat/completions') && body?.stream === false) return Response.json({ choices: [{ message: {
    content: process.env.IRIS_CHAT_FIXTURE_MODE === 'text' ? 'Only text, no image.' : '![image](data:image/png;base64,' + jpeg.toString('base64') + ')'
  } }] });
  throw new Error('unexpected fixture endpoint');
};
