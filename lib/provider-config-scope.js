import { AsyncLocalStorage } from 'node:async_hooks';

// Resolved credentials live only in one operation's asynchronous context.
const scope = new AsyncLocalStorage();

export function scopedProvider(provider) {
  return (provider.dshProvider && scope.getStore()?.get(provider.id)) || provider;
}

export function hasProviderConfigScope() {
  return scope.getStore() !== undefined;
}

export function withProviderConfigScope(providers, callback) {
  return scope.run(new Map(providers.map(provider => [provider.id, provider])), callback);
}
