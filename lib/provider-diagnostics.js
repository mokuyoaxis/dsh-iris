import { catalogCapabilitySnapshot } from './provider-catalog.js';
import { providerModels, functionPolicy, parseModelRef } from './models.js';
import { isConfiguredProvider, supportsModelCapability } from './provider-protocol.js';
import { healthObservationState, newestHealthEvidence, modelRateLimit } from './provider-health.js';
import { listCoreTasks, findFlowTask } from './core-tasks.js';
import { flowReferences } from './flow-store.js';

/** Uses the same routing and health rules as submissions. No discovery, network calls or writes. */
export function projectProviderDiagnostics(catalog, registry) {
  const routes = catalogCapabilitySnapshot(catalog, registry).capabilities;
  const capabilities = routes.map(route => {
    const models = catalog.providers.flatMap(provider => providerModels(provider).filter(model => model.capabilities.includes(route.capability)).map(model => {
      const observation = provider.health?.observations?.find(item => item.modelId === model.id && item.capability === route.capability);
      const legacy = model.verified?.[route.capability];
      const evidence = observation || (legacy ? { [legacy.ok ? 'lastSuccess' : ['auth', 'authentication', 'permission'].includes(legacy.category) ? 'lastFailure' : 'lastTransient']: legacy } : undefined);
      const limit = modelRateLimit(provider, model.id);
      const latest = newestHealthEvidence(evidence);
      const reason = provider.enabled === false ? 'provider_disabled' : !isConfiguredProvider(provider) ? 'connection_unconfigured'
        : route.mode === 'disabled' ? 'function_disabled' : model.source === 'discovered' ? 'unconfirmed'
          : !supportsModelCapability(provider, model.id, route.capability, { registry }) ? 'protocol_unsupported'
            : model.unavailableCapabilities?.includes(route.capability) ? 'model_missing' : limit ? limit.until ? 'cooling' : 'quota'
              : !route.candidates.includes(model.ref) ? 'outside_pool' : null;
      return { ref: model.ref, providerId: provider.id, providerName: provider.name || provider.id, modelId: model.id,
        eligible: !reason, reason, rank: reason ? null : route.candidates.indexOf(model.ref) + 1,
        state: healthObservationState(evidence), evidence: latest ? { at: latest.at, source: ['probe', 'task'].includes(latest.source) ? latest.source : 'unknown',
          category: ['success', 'authentication', 'auth', 'permission', 'rate_limit', 'quota', 'network', 'timeout', 'protocol', 'unknown'].includes(latest.category) ? latest.category : 'unknown' } : null,
        ...(limit?.until ? { retryAt: limit.until } : {}),
        comfy: Boolean(provider.models?.find(item => item?.id === model.id)?.comfyWorkflow) };
    }));
    return { capability: route.capability, mode: route.mode, candidates: models.filter(model => model.eligible).sort((a, b) => a.rank - b.rank).map(model => model.ref),
      verified: models.filter(model => model.eligible && model.state === 'verified').length, models };
  });
  const result = { contractVersion: 0, capabilities };
  const keys = catalog.providers.map(provider => provider.apiKey).filter(key => typeof key === 'string' && key);
  const scrub = value => typeof value === 'string' ? keys.reduce((text, key) => text.split(key).join('[redacted]'), value)
    : Array.isArray(value) ? value.map(scrub) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)])) : value;
  return scrub(result);
}

/** Current root only, under the caller's Core lease; unknown/corrupt records must fail visibly. */
export function providerDependencies(root, providerId) {
  const tasks = []; let offset = 0, page;
  do { page = listCoreTasks(root, { provider_id: providerId, offset, limit: 200 }); tasks.push(...page.tasks); offset += page.limit; } while (offset < page.total);
  const recoverable = task => task.acceptance === 'unknown' || ['none', 'unknown'].includes(task.outcome)
    || task.outcome === 'succeeded' && task.deliveryState !== 'ready' || task.cancelState === 'requested';
  const blockingTasks = tasks.filter(recoverable).map(task => task.id);
  const blockingRuns = flowReferences(root).filter(({ run }) => parseModelRef(run.input.model_ref)?.providerId === providerId)
    .filter(({ run }) => { const task = findFlowTask(root, run); return !task || recoverable(task); }).map(({ run }) => run.id);
  return { scope: 'current-core-root', blockingTasks, blockingRuns, historicalTasks: tasks.length };
}

export function providerRemovalImpact(catalog, providerId) {
  const provider = catalog.providers.find(item => item.id === providerId);
  return { modelCount: provider ? providerModels(provider).length : 0, functions: Object.entries(catalog.assignments || {}).filter(([cap, value]) =>
    functionPolicy(value, cap).models.some(ref => parseModelRef(ref)?.providerId === providerId)).map(([cap]) => cap) };
}
