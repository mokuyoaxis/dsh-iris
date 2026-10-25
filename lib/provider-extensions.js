// Experimental v0 package boundary. This is not the complete Core SDK.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { builtinProviderExtension } from './provider-adapters.js';
import { createExtensionRegistry } from './provider-registry.js';

export { defineProviderAdapter, PROVIDER_ADAPTER_CONTRACT_VERSION } from './provider-adapter.js';
export { ProviderContractError } from './provider-contract.js';
export { normalizeMediaEndpoint } from './provider-protocol.js';
export { PROVIDER_EXTENSION_CONTRACT_VERSION } from './provider-registry.js';

export function createProviderRegistry({ extensions = [] } = {}) {
  if (!Array.isArray(extensions)) throw new TypeError('extensions 必须是工厂数组');
  return createExtensionRegistry([builtinProviderExtension, ...extensions]);
}

/** Trusted code only. Explicit absolute entry files; no discovery or package installation. */
export async function loadProviderRegistry(entries = []) {
  const factories = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry) || !/\.m?js$/.test(entry)
        || !fs.statSync(entry).isFile()) throw new TypeError('Provider 扩展入口必须是明确的 JS/MJS 文件绝对路径');
    const module = await import(pathToFileURL(fs.realpathSync(entry)).href);
    if (typeof module.default !== 'function') throw new TypeError('Provider 扩展须默认导出实例工厂函数');
    factories.push(module.default);
  }
  return createProviderRegistry({ extensions: factories });
}
