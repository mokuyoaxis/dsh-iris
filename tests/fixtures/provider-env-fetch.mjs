// Test-only redirect of built-in DashScope requests to an owned HTTP server.
const origin = process.env.IRIS_TEST_ENV_UPSTREAM;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || '')) throw new Error('Missing owned provider fixture');
const previous = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (['https://dashscope.aliyuncs.com', 'https://dashscope-intl.aliyuncs.com'].includes(url.origin)) {
    return previous(new URL(url.pathname + url.search, origin), init);
  }
  if (url.origin === origin) return previous(input, init);
  throw new Error('Unexpected network request in credential fixture');
};
