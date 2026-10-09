/** CLI 真实子进程的隔离 HTTP 夹具；所有未覆盖请求由既有夹具拒绝，无真实网络。 */
import fs from 'node:fs';
import './headless-async-fetch.mjs';
const previousFetch = globalThis.fetch;
const stateFile = process.env.IRIS_ASYNC_FIXTURE_STATE;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8XnWQAAAABJRU5ErkJggg==';
globalThis.fetch = async (input, options = {}) => {
  const url = String(input), pathname = new URL(url).pathname;
  const state = JSON.parse(fs.readFileSync(stateFile));
  const body = options.body ? JSON.parse(options.body) : null;
  state.requests ||= [];
  state.requests.push({ pathname, model: body?.model, method: options.method || 'GET',
    correctAuth: new Headers(options.headers).get('authorization') === 'Bearer protocol-cli-fixture-key' });
  if (pathname.endsWith('/models')) {
    fs.writeFileSync(stateFile, JSON.stringify(state));
    return Response.json({ output: { total: 2, models: [
      { model: 'wan2.2-t2i-flash', capabilities: ['IG'] }, { model: 'custom-image', capabilities: ['IG', 'VU'] }
    ] } });
  }
  if (pathname.endsWith('/images/generations')) {
    state.images = (state.images || 0) + 1;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    return Response.json({ data: [{ b64_json: png }] });
  }
  fs.writeFileSync(stateFile, JSON.stringify(state));
  return previousFetch(input, options);
};
