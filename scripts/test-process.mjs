// Node 20.10.0 can deadlock in native shutdown after all JS exit handlers have
// completed. Avoid background optimizing compilation in this minimum-version
// test lane; retain normal compilation in newer lanes and natural process exit.
// Related upstream investigation: https://github.com/nodejs/node/issues/54918
export const testNodeArgs = process.versions.node === '20.10.0'
  ? ['--no-concurrent-recompilation']
  : [];

export function testProcessArgs(testFile) {
  return [
    ...testNodeArgs,
    '--import', new URL('./test-shutdown.mjs', import.meta.url).href,
    testFile
  ];
}
