import fs from 'node:fs';
import assert from 'node:assert/strict';
import { FAKE_WAV } from './fake-lifecycle-provider.mjs';

global.fetch = async (url, init) => {
  assert.equal(String(url), 'https://music.fixture.invalid/v1/chat/completions', 'fixture 禁止外部网络请求');
  const file = process.env.IRIS_MUSIC_FIXTURE_STATE;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'gemini-music');
  assert.equal(body.stream, false);
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-music-key');
  state.calls = (state.calls || 0) + 1;
  state.lastRequest = body;
  const status = state.statuses?.shift() || 200;
  fs.writeFileSync(file, JSON.stringify(state));
  return new Response(JSON.stringify(status !== 200 ? { error: { message: 'fixture upstream error' } }
    : { choices: [{ message: { content: state.textOnly ? 'only song description' :
      '[audio](data:audio/wav;base64,' + FAKE_WAV.toString('base64') + ')' } }] }), { status });
};
