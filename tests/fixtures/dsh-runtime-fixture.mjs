/** Test-only wiring for legacy assertions; production always receives an explicit plugin instance. */
import * as dsh from '../../lib/dsh-core-adapter.js';
import * as plugin from '../../lib/index.js';
import * as actions from '../../lib/actions.js';
import * as api from '../../lib/api.js';
import * as gallery from '../../lib/workbench-artifacts.js';
import * as management from '../../lib/workbench-management.js';

export * from '../../lib/dsh-core-adapter.js';
export * from '../../lib/index.js';
export * from '../../lib/actions.js';
export * from '../../lib/api.js';
export * from '../../lib/workbench-artifacts.js';
export * from '../../lib/workbench-management.js';

const instances = new Set();
let current, host = () => undefined;
function runtime() {
  if (!current) {
    current = dsh.createDshRuntime({ dataRoot: dsh.dshCoreDataRoot(), getHost: () => host() });
    instances.add(current);
  }
  return current;
}
export function fixtureRuntime() { return runtime(); }
export function configureProviderHostForDsh(factory) {
  host = factory;
  return () => { if (host === factory) host = () => undefined; };
}
export async function apply(ctx) {
  // Older lightweight fake contexts predate the service that now owns the DSH runtime.
  if (typeof ctx.provide !== 'function') {
    const provided = new Map(), originalGet = ctx.get?.bind(ctx);
    ctx.provide = (name, value) => { provided.set(name, value); };
    ctx.get = name => provided.has(name) ? provided.get(name) : originalGet?.(name);
  }
  await plugin.apply(ctx);
  current = ctx.get('irisRuntime');
  instances.add(current);
}
export function runAction(host, name, args, options = {}) {
  return actions.runAction(host, name, args, { ...options, core: options.core || runtime() });
}
export function serveApi(req, res, host, core = runtime()) { return api.serveApi(req, res, host, core); }
export function workbenchArtifacts(input, options = {}) {
  return gallery.workbenchArtifacts(input, { ...options, core: options.core || runtime() });
}
export function workbenchDetail(source, id, options = {}) {
  return management.workbenchDetail(source, id, { ...options, core: options.core || runtime() });
}
export function downloadWorkbenchSelection(input, options = {}) {
  return management.downloadWorkbenchSelection(input, { ...options, core: options.core || runtime() });
}
export function deleteWorkbenchArtifacts(input, options = {}) {
  return management.deleteWorkbenchArtifacts(input, { ...options, core: options.core || runtime() });
}
export function workbenchTransactions(options = {}) {
  return management.workbenchTransactions({ ...options, core: options.core || runtime() });
}
export function restoreWorkbenchTransaction(input, options = {}) {
  return management.restoreWorkbenchTransaction(input, { ...options, core: options.core || runtime() });
}

export const importImageForDsh = (...args) => runtime().importImageForDsh(...args);
export const cropForDsh = (...args) => runtime().cropForDsh(...args);
export const htmlForDsh = (...args) => runtime().htmlForDsh(...args);
export const diffForDsh = (...args) => runtime().diffForDsh(...args);
export const framesForDsh = (...args) => runtime().framesForDsh(...args);
export const summaryFramesForDsh = (...args) => runtime().summaryFramesForDsh(...args);
export const visionImageForDsh = (...args) => runtime().visionImageForDsh(...args);
export const submitProviderTaskForDsh = (...args) => runtime().submitProviderTaskForDsh(...args);
export const submitMusicForDsh = (...args) => runtime().submitMusicForDsh(...args);
export const observeProviderTaskForDsh = (...args) => runtime().observeProviderTaskForDsh(...args);
export const reobserveProviderTaskForDsh = (...args) => runtime().reobserveProviderTaskForDsh(...args);
export const redeliverProviderTaskForDsh = (...args) => runtime().redeliverProviderTaskForDsh(...args);
export const cancelProviderTaskForDsh = (...args) => runtime().cancelProviderTaskForDsh(...args);
export const disposeCoreTaskAttention = (...args) => runtime().disposeCoreTaskAttention(...args);
export const retryProviderTaskForDsh = (...args) => runtime().retryProviderTaskForDsh(...args);
export const watchProviderTaskForDsh = (...args) => runtime().watchProviderTaskForDsh(...args);
export const resumeProviderTaskWatchesForDsh = (...args) => runtime().resumeProviderTaskWatchesForDsh(...args);
export const inspectProviderTaskForDsh = (...args) => runtime().inspectProviderTaskForDsh(...args);
export const galleryArtifactsForDsh = (...args) => runtime().galleryArtifactsForDsh(...args);
export const inspectWorkbenchArtifactForDsh = (...args) => runtime().inspectWorkbenchArtifactForDsh(...args);
export const maintainWorkbenchForDsh = (...args) => runtime().maintainWorkbenchForDsh(...args);
export const coreSnapshotForDsh = (...args) => runtime().coreSnapshotForDsh(...args);
export const readCoreArtifactMediaForDsh = (...args) => runtime().readCoreArtifactMediaForDsh(...args);
export const projectCoreTaskForDsh = (...args) => runtime().projectCoreTaskForDsh(...args);
export function stopProviderTaskWatchesForDsh() {
  return Promise.all([...instances].map(instance => instance.stopProviderTaskWatchesForDsh()));
}
process.once('beforeExit', async () => {
  const results = await Promise.allSettled([...instances].map(instance => instance.dispose()));
  for (const result of results) if (result.status === 'rejected') {
    console.error('DSH fixture cleanup failed: ' + (result.reason?.code || result.reason?.name));
    process.exitCode = 1;
  }
});
