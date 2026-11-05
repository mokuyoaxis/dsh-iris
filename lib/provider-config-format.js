// Network-enabled catalogs use an outer envelope which older loaders reject.
import { CATALOG_NETWORK, checkedNetworkRequirement, sameNetworkRequirement } from './network-policy.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'IRIS_PROVIDER_CONFIG_INVALID' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function markedCatalog(catalog, requirement) {
  if (!object(catalog) || !Array.isArray(catalog.providers) || catalog.providers.some(provider => !object(provider))) {
    fail('Provider 配置内容无效');
  }
  const ids = new Set();
  for (const provider of catalog.providers) {
    if (typeof provider.id !== 'string' || !provider.id.trim() || provider.id.length > 256 || /[\x00-\x1f\x7f]/.test(provider.id) || ids.has(provider.id)) fail('网络目录需要明确、唯一且不含控制字符的供应商身份');
    ids.add(provider.id);
  }
  const identity = Object.freeze(checkedNetworkRequirement(requirement));
  return { ...catalog, [CATALOG_NETWORK]: identity,
    providers: catalog.providers.map(provider => ({ ...provider, [CATALOG_NETWORK]: identity })) };
}

export function decodeProviderConfig(parsed) {
  if (object(parsed) && Object.hasOwn(parsed, 'providers') && Object.hasOwn(parsed, 'networkRequirement')) fail('网络目录不能与旧根 providers 字段混用，拒绝忽略网络要求');
  if (!object(parsed) || Object.hasOwn(parsed, 'providers')) return parsed;
  if (parsed.schemaVersion !== 1 || Object.keys(parsed).length !== 3
      || !Object.hasOwn(parsed, 'networkRequirement') || !Object.hasOwn(parsed, 'catalog')) {
    fail('Provider 网络配置包装版本或字段无效；请使用兼容版本，原文件不会自动迁移');
  }
  return markedCatalog(parsed.catalog, parsed.networkRequirement);
}

export function encodeProviderConfig(catalog) {
  const requirement = catalog?.[CATALOG_NETWORK];
  if (requirement === undefined) {
    if (catalog?.providers?.some(provider => provider?.[CATALOG_NETWORK] !== undefined)) fail('Provider 网络配置身份丢失，拒绝写回旧格式');
    return catalog;
  }
  const checked = checkedNetworkRequirement(requirement);
  for (const provider of catalog.providers) {
    const identity = provider?.[CATALOG_NETWORK];
    if (identity !== undefined && !sameNetworkRequirement(checked, identity)) fail('Provider 与目录的网络配置身份不一致');
  }
  const { [CATALOG_NETWORK]: _identity, ...contents } = catalog;
  return { schemaVersion: 1, networkRequirement: checked, catalog: contents };
}

/** Return a new marked runtime catalog; callers explicitly write a new file. */
export function wrapProviderCatalog(catalog, requirement) {
  const original = encodeProviderConfig(catalog);
  const contents = catalog?.[CATALOG_NETWORK] === undefined ? original : original.catalog;
  return markedCatalog(JSON.parse(JSON.stringify(contents)), requirement);
}
