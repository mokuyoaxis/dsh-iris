// Internal composition port. No proxy configuration, global mutation or automatic retry.
export function inheritedProviderFetch(...args) { return globalThis.fetch(...args); }

function closed() {
  return Object.assign(new Error('Provider 网络客户端正在关闭或已关闭'), {
    code: 'IRIS_PROVIDER_NETWORK_CLOSED', stage: 'validate', category: 'invalid_request', acceptance: 'not_accepted'
  });
}

export function assertProviderNetwork(network) {
  if (!network || typeof network.fetch !== 'function' || typeof network.run !== 'function') {
    throw new TypeError('network 需要实例级 fetch 和完整操作 run');
  }
  return network;
}

/** The owner drains Core/registry operations before disposing this client. */
export function createProviderNetworkClient({ fetchPort, close } = {}) {
  if (fetchPort !== undefined && typeof fetchPort !== 'function') throw new TypeError('fetchPort 必须是函数');
  if (close !== undefined && typeof close !== 'function') throw new TypeError('close 必须是函数');
  const active = new Set();
  let state = 'open', disposal, cleanupFailed = false;
  const snapshot = () => Object.freeze({ state, activeOperations: active.size, cleanupFailed });

  // Used inside run: closing must still permit later pages, uploads and body reads.
  const fetch = (...args) => {
    if (state === 'closed') return Promise.reject(closed());
    return (fetchPort || inheritedProviderFetch)(...args);
  };
  function run(action) {
    if (typeof action !== 'function') throw new TypeError('网络操作必须是函数');
    if (state !== 'open') return Promise.reject(closed());
    const operation = Promise.resolve().then(() => action(fetch));
    active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  }
  function dispose() {
    if (!disposal) {
      state = 'closing';
      disposal = (async () => {
        await Promise.allSettled([...active]);
        try { await close?.(); }
        catch (error) { cleanupFailed = true; throw error; }
        finally { state = 'closed'; }
        return snapshot();
      })();
    }
    return disposal;
  }
  return Object.freeze({ fetch, run, dispose, snapshot });
}
