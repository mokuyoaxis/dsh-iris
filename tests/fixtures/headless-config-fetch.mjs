import './headless-vision-fetch.mjs';
const previousFetch = globalThis.fetch;
globalThis.fetch = (input, options = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/models')) return Promise.resolve(Response.json({ data: [{ id: 'qwen-vl-plus' }, { id: 'gpt-image-1' }, { id: 'other-unknown' }] }));
  return previousFetch(input, options);
};
