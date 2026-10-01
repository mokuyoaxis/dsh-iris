// Node 20.10.0 can deadlock in native shutdown after all JS exit handlers have
// completed. Avoid background V8 compilation/GC work in this minimum-version
// test lane; newer lanes retain normal V8 scheduling and all tests exit naturally.
// This flag affects V8 tasks, not async I/O or Iris's task/watch concurrency.
// Related upstream investigation: https://github.com/nodejs/node/issues/54918
export const testNodeArgs = process.versions.node === '20.10.0'
  ? ['--single-threaded']
  : [];

export function testProcessArgs(testFile) {
  return [
    ...testNodeArgs,
    '--import', new URL('./test-shutdown.mjs', import.meta.url).href,
    testFile
  ];
}
