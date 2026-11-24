// Read-only workspace artifact directory and provenance/lineage projection.
// Uses existing Artifact.relations and FlowRun references with zero disk migration.
import { inspectCoreArtifactMetadata, listCoreArtifactMetadata } from './core-artifact-store.js';
import { listFlowRuns, readFlowRun } from './flow-store.js';
import { MAX_IMPORT_IMAGE_BYTES } from './image-import.js';
import { AUDIO_TYPES, MAX_AUDIO_INPUT_BYTES } from './audio-flow-input.js';
import { VIDEO_TYPES, MAX_VIDEO_BYTES } from './video-flow-input.js';

const STATIC_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_TEXT_JSON_BYTES = 1024 * 1024;
const ARTIFACT_ID = /^artifact_[a-f0-9]{24}$/;
const MAX_LINEAGE_ITEMS = 50;
const PRODUCED_ROLES = ['output', 'comparison', 'report'];

function compareNewest(a, b) {
  return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    || String(b.id || b.artifactId || b.runId || '').localeCompare(String(a.id || a.artifactId || a.runId || ''));
}

function summarizeArtifact(artifact, extra = {}) {
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    size: artifact.size,
    createdAt: artifact.createdAt,
    ...(Number.isSafeInteger(artifact.metadata?.width) ? { width: artifact.metadata.width } : {}),
    ...(Number.isSafeInteger(artifact.metadata?.height) ? { height: artifact.metadata.height } : {}),
    ...extra
  };
}

function runArtifactRoles(run) {
  const roles = new Map();
  const add = (ref, role) => {
    const id = ref?.artifactId;
    if (!id || !ARTIFACT_ID.test(id)) return;
    if (!roles.has(id)) roles.set(id, []);
    const list = roles.get(id);
    if (!list.includes(role)) list.push(role);
  };
  add(run.source, 'source');
  if (Array.isArray(run.sources)) for (const ref of run.sources) add(ref, 'source');
  add(run.output, 'output');
  add(run.comparison, 'comparison');
  add(run.selection, 'selection');
  add(run.report, 'report');
  return roles;
}

function summarizeRun(run, roles) {
  return {
    runId: run.id,
    recipe: run.recipe,
    modelRef: run.input.model_ref,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    roles
  };
}

function matchesWorkspaceKind(item, kind) {
  if (kind === 'all') return true;
  if (kind === 'image') return STATIC_IMAGE_TYPES.has(item.mediaType) && item.size > 0 && item.size <= MAX_IMPORT_IMAGE_BYTES;
  if (kind === 'audio') return Object.hasOwn(AUDIO_TYPES, item.mediaType) && item.size > 0 && item.size <= MAX_AUDIO_INPUT_BYTES;
  if (kind === 'video') return Object.hasOwn(VIDEO_TYPES, item.mediaType) && item.size > 0 && item.size <= MAX_VIDEO_BYTES;
  if (kind === 'text') return item.mediaType === 'text/plain' && item.size > 0 && item.size <= MAX_TEXT_JSON_BYTES;
  if (kind === 'json') return item.mediaType === 'application/json' && item.size > 0 && item.size <= MAX_TEXT_JSON_BYTES;
  return false;
}

/** Bounded read-only workspace artifact list for owner local tools (zero content re-hash). */
export function listWorkspaceArtifacts(dataRoot, { kind = 'image', limit = 30, offset = 0 } = {}) {
  const { artifacts } = listCoreArtifactMetadata(dataRoot, { includeLegacy: true });
  const filtered = artifacts
    .filter(item => matchesWorkspaceKind(item, kind))
    .sort(compareNewest);
  const page = filtered.slice(offset, offset + limit);
  return {
    total: filtered.length,
    offset,
    limit,
    nextOffset: offset + page.length < filtered.length ? offset + page.length : null,
    artifacts: page.map(item => summarizeArtifact(item))
  };
}

/** Read-only provenance graph (parents, direct children and referencing Runs) for one Artifact. */
export function inspectArtifactLineage(dataRoot, artifactId, { includeRuns = true, allowedArtifactIds = null } = {}) {
  const target = inspectCoreArtifactMetadata(dataRoot, artifactId);
  const { artifacts } = listCoreArtifactMetadata(dataRoot, { includeLegacy: true });
  const byId = new Map(artifacts.map(item => [item.id, item]));
  const allowArtifact = id => !allowedArtifactIds || allowedArtifactIds.has(id);

  const parents = [];
  const seenParents = new Set();
  let missingParents = 0;
  for (const rel of target.relations || []) {
    if (!ARTIFACT_ID.test(rel?.artifactId || '')) continue;
    const key = rel.type + ':' + rel.artifactId;
    if (seenParents.has(key)) continue;
    seenParents.add(key);
    if (!allowArtifact(rel.artifactId)) continue;
    const parent = byId.get(rel.artifactId);
    if (!parent) { missingParents++; continue; }
    parents.push(summarizeArtifact(parent, { relation: rel.type }));
  }

  const allChildren = [];
  for (const candidate of artifacts) {
    if (candidate.id === artifactId || !allowArtifact(candidate.id)) continue;
    for (const rel of candidate.relations || []) {
      if (rel?.artifactId === artifactId) {
        allChildren.push(summarizeArtifact(candidate, { relation: rel.type }));
      }
    }
  }
  allChildren.sort(compareNewest);

  const referencingRuns = [];
  if (includeRuns) {
    const runs = listFlowRuns(dataRoot);
    for (const run of runs) {
      const roles = runArtifactRoles(run).get(artifactId);
      if (roles?.length) referencingRuns.push(summarizeRun(run, roles));
    }
    referencingRuns.sort(compareNewest);
  }

  return {
    artifact: summarizeArtifact(target),
    parents: parents.slice(0, MAX_LINEAGE_ITEMS),
    totalParents: parents.length,
    missingParents,
    children: allChildren.slice(0, MAX_LINEAGE_ITEMS),
    totalChildren: allChildren.length,
    runs: referencingRuns.slice(0, MAX_LINEAGE_ITEMS),
    totalRuns: referencingRuns.length
  };
}

/** Read-only provenance graph for one durable Flow Run (upstream, direct derived artifacts, downstream Runs). */
export function inspectRunLineage(dataRoot, runId) {
  const run = readFlowRun(dataRoot, runId);
  const { artifacts } = listCoreArtifactMetadata(dataRoot, { includeLegacy: true });
  const byId = new Map(artifacts.map(item => [item.id, item]));
  const runs = listFlowRuns(dataRoot);

  const runRoles = runArtifactRoles(run);
  const producedIds = new Set();
  const runArtifacts = [];
  for (const [id, roles] of runRoles.entries()) {
    const item = byId.get(id);
    if (!item) continue;
    runArtifacts.push(summarizeArtifact(item, { roles }));
    if (roles.some(role => PRODUCED_ROLES.includes(role))) producedIds.add(id);
  }

  const sourceIds = new Set();
  if (run.source?.artifactId) sourceIds.add(run.source.artifactId);
  if (Array.isArray(run.sources)) for (const ref of run.sources) if (ref?.artifactId) sourceIds.add(ref.artifactId);

  // Upstream parent artifacts referenced by this Run's sources through saved Artifact relations.
  const upstreamArtifacts = [];
  const upstreamArtifactIds = new Set();
  const missingUpstreamIds = new Set();
  for (const sourceId of sourceIds) {
    const source = byId.get(sourceId);
    if (!source) { missingUpstreamIds.add(sourceId); continue; }
    for (const rel of source.relations || []) {
      if (!ARTIFACT_ID.test(rel?.artifactId || '')) continue;
      if (sourceIds.has(rel.artifactId) || upstreamArtifactIds.has(rel.artifactId)) continue;
      const parent = byId.get(rel.artifactId);
      if (!parent) { missingUpstreamIds.add(rel.artifactId); continue; }
      upstreamArtifactIds.add(parent.id);
      upstreamArtifacts.push(summarizeArtifact(parent, { relation: rel.type, viaArtifactId: sourceId }));
    }
  }
  upstreamArtifacts.sort(compareNewest);

  // Direct derived child artifacts created from any artifact belonging to this Run (excluding this Run's own artifacts).
  const directDerived = [];
  const consumerTargets = new Set(producedIds);
  for (const candidate of artifacts) {
    if (runRoles.has(candidate.id)) continue;
    const links = candidate.relations.filter(rel => byId.has(rel.artifactId) && runRoles.has(rel.artifactId));
    if (!links.length) continue;
    const producedLink = links.find(rel => producedIds.has(rel.artifactId));
    if (producedLink) consumerTargets.add(candidate.id);
    const link = producedLink || links[0];
    directDerived.push(summarizeArtifact(candidate, {
      relation: link.type,
      viaArtifactId: link.artifactId,
      viaRoles: runRoles.get(link.artifactId)
    }));
  }
  directDerived.sort(compareNewest);

  // Only a stored output, comparison or report establishes which Run produced an Artifact.
  const upstreamRuns = [];
  const downstreamRuns = [];
  const producerTargets = new Set([...sourceIds].filter(id => byId.has(id)).concat([...upstreamArtifactIds]));

  for (const other of runs) {
    if (other.id === run.id) continue;
    const otherRoles = runArtifactRoles(other);
    const producedLinks = [];
    const producerRoles = new Set();
    const consumedLinks = [];
    for (const [id, roles] of otherRoles.entries()) {
      if (producerTargets.has(id)) {
        const producing = roles.filter(role => PRODUCED_ROLES.includes(role));
        if (producing.length) {
          producedLinks.push(id);
          for (const role of producing) producerRoles.add(role);
        }
      }
      if (consumerTargets.has(id) && roles.includes('source')) {
        consumedLinks.push(id);
      }
    }
    if (producedLinks.length || run.retriedFrom?.runId === other.id) {
      const roles = [...producerRoles];
      if (run.retriedFrom?.runId === other.id && !roles.includes('retried-from')) roles.push('retried-from');
      upstreamRuns.push({ ...summarizeRun(other, roles), linkedArtifactIds: producedLinks });
    }
    if (consumedLinks.length || other.retriedFrom?.runId === run.id) {
      const roles = [];
      if (consumedLinks.length) roles.push('source');
      if (other.retriedFrom?.runId === run.id) roles.push('retried-from');
      downstreamRuns.push({ ...summarizeRun(other, roles), linkedArtifactIds: consumedLinks });
    }
  }
  upstreamRuns.sort(compareNewest);
  downstreamRuns.sort(compareNewest);

  return {
    runId: run.id,
    recipe: run.recipe,
    ...(run.retriedFrom ? { retriedFrom: { ...run.retriedFrom } } : {}),
    artifacts: runArtifacts,
    upstreamArtifacts: upstreamArtifacts.slice(0, MAX_LINEAGE_ITEMS),
    totalUpstreamArtifacts: upstreamArtifacts.length,
    missingUpstream: missingUpstreamIds.size,
    upstreamRuns: upstreamRuns.slice(0, MAX_LINEAGE_ITEMS),
    totalUpstreamRuns: upstreamRuns.length,
    directDerived: directDerived.slice(0, MAX_LINEAGE_ITEMS),
    totalDirectDerived: directDerived.length,
    downstreamRuns: downstreamRuns.slice(0, MAX_LINEAGE_ITEMS),
    totalDownstreamRuns: downstreamRuns.length
  };
}
