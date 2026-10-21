import fs from 'node:fs';
const previous = globalThis.fetch;
const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWNg+M9AGmIY1cAwGkr/h2nSAACR6v8BoHaaQQAAAABJRU5ErkJggg==';
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== 'https://flow.fixture.invalid/v1/chat/completions') return previous(input, init);
  const body = JSON.parse(init.body);
  if (body.model !== 'edit' || !body.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,')) throw new Error('Invalid packaged Flow input');
  const file = process.env.IRIS_ASYNC_FIXTURE_STATE;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.flowSubmits = (state.flowSubmits || 0) + 1;
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  return Response.json({ choices: [{ message: { content: '![edit](data:image/png;base64,' + png + ')' } }] });
};
