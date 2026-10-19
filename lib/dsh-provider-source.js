/** Read only public DSH services; never open profile or credential files. */
export class DshProviderSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DshProviderSourceError';
    this.code = 'IRIS_DSH_PROVIDER_UNAVAILABLE';
  }
}

const unavailable = message => { throw new DshProviderSourceError(message); };
const refName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const recordId = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);

async function credentialRead(read) {
  try { return await read(); }
  catch (_) { unavailable('DSH 凭据服务读取失败，请在宿主检查该连接'); }
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch (_) { unavailable('DSH 连接没有可复用的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    unavailable('DSH 连接地址包含不支持的协议或凭据参数');
  }
  return url.href.replace(/\/+$/, '');
}

export function createDshProviderSource(services) {
  function entries() {
    const { llm, settings, credentials } = services();
    if (typeof llm?.listProviders !== 'function' || typeof llm?.listConfigurableProviders !== 'function'
        || typeof settings?.describe !== 'function') {
      unavailable('当前 DSH 未提供连接目录与设置接口，请手动添加 Iris 供应商');
    }
    const active = new Set(llm.listProviders().map(provider => provider.id));
    const forms = settings.describe({ redactSecrets: true });
    return llm.listConfigurableProviders().filter(entry => active.has(entry.provider)).map(entry => {
      let profile = forms.find(form => form.ns === entry.settingsNs)?.value;
      for (const key of entry.settingsPath) profile = profile && Object.hasOwn(profile, key) ? profile[key] : undefined;
      return { entry, profile, credentials };
    });
  }

  async function facts({ entry, profile, credentials }) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) unavailable('DSH 连接设置不可读取');
    if (profile.headers && Object.keys(profile.headers).length) unavailable('该 DSH 连接含自定义请求头，当前请手动配置 Iris 供应商');
    const baseUrl = endpoint(profile.baseURL || entry.defaultBaseURL);
    if (!credentials) unavailable('当前 DSH 没有凭据解析服务，请手动配置 Iris 供应商');
    if (profile.apiKeyEnv !== undefined) {
      if (!refName(profile.apiKeyEnv) || typeof credentials.describe !== 'function'
          || typeof credentials.resolve !== 'function') unavailable('DSH 凭据引用不可用');
      if (!(await credentialRead(() => credentials.describe(profile.apiKeyEnv))).configured) unavailable('DSH 连接尚未配置可用密钥');
      return { baseUrl, ref: profile.apiKeyEnv };
    }
    // This is the documented api-key record space owned by llm-pi-ai.
    if (entry.settingsNs === 'llm-pi-ai' && recordId(entry.provider)
        && typeof credentials.describeRecord === 'function' && typeof credentials.readRecord === 'function') {
      const key = 'llm-pi-ai/' + entry.provider;
      const info = await credentialRead(() => credentials.describeRecord(key));
      if (info.configured) {
        if (info.kind !== 'api-key') unavailable('该 DSH 连接使用登录授权，当前不支持将其用于媒体请求');
        return { baseUrl, recordKey: key };
      }
    }
    for (const ref of entry.nativeAuth?.env || []) {
      if (refName(ref) && typeof credentials.describe === 'function' && typeof credentials.resolve === 'function'
          && (await credentialRead(() => credentials.describe(ref))).configured) return { baseUrl, ref };
    }
    unavailable('该 DSH 连接没有可复用的 API Key；登录授权和专有认证需单独适配');
  }

  async function list() {
    return Promise.all(entries().map(async source => {
      const { entry } = source;
      const common = { provider: entry.provider, settingsNs: entry.settingsNs, name: entry.displayName || entry.provider };
      try { return { ...common, baseUrl: (await facts(source)).baseUrl, available: true }; }
      catch (error) {
        if (!(error instanceof DshProviderSourceError)) throw error;
        return { ...common, available: false, reason: error.message };
      }
    }));
  }

  async function resolve(reference, { signal } = {}) {
    signal?.throwIfAborted();
    const source = entries().find(({ entry }) => entry.provider === reference.provider && entry.settingsNs === reference.settingsNs);
    if (!source) unavailable('DSH 原连接已停用、移除或改变来源，请检查宿主供应商设置');
    const plan = await facts(source);
    let key;
    if (plan.ref) key = (await credentialRead(() => source.credentials.resolve(plan.ref)))?.value;
    else {
      const record = await credentialRead(() => source.credentials.readRecord(plan.recordKey));
      if (record?.kind === 'api-key') key = record.key;
    }
    signal?.throwIfAborted();
    if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) unavailable('DSH 原连接没有可用于媒体请求的 API Key');
    // Even accidental JSON serialization of this Host-only result excludes the key.
    return Object.freeze(Object.defineProperty({ baseUrl: plan.baseUrl }, 'apiKey', { value: key }));
  }

  return Object.freeze({ list, resolve });
}
