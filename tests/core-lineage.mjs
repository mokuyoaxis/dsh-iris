import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { inspectArtifactLineage, inspectRunLineage, listWorkspaceArtifacts } from '../lib/core-lineage.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-core-lineage');
const dataRoot = path.join(root, 'core');
const fixture = imageFlowFixture(dataRoot);
const app = createApplicationRuntime({ dataRoot, ...fixture });
const services = [];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function tree() {
  return Object.fromEntries(
    fs.readdirSync(dataRoot, { recursive: true, withFileTypes: true })
      .filter(item => item.isFile())
      .map(item => {
        const file = path.join(item.parentPath, item.name);
        return [path.relative(dataRoot, file), digest(fs.readFileSync(file))];
      })
  );
}

try {
  await app.execute('flow.init', {});
  await app.execute('execution.init', { vision: true });

  // 1. Seed a plain PNG and an EXIF orientation 6 JPEG (raw 80x40, displayed 40x80).
  const sourceA = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const rawExifPng = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#264653' } }).png().toBuffer();
  const exif6Jpeg = await sharp(rawExifPng).withMetadata({ orientation: 6 }).jpeg({ quality: 96 }).toBuffer();
  const sourceExif = (await app.execute('artifact.import', { image_bytes: exif6Jpeg })).artifact;

  // 2. Run 1: image-edit on sourceA -> output + comparison.
  const run1Draft = await app.execute('flow.create', { source_artifact_id: sourceA.id, model_ref: FLOW_MODEL, prompt: 'adjust sky' });
  const run1Done = await app.execute('flow.continue', { run_id: run1Draft.run.id });
  const run1Id = run1Done.run.id;
  const run1OutputId = run1Done.run.output.artifactId;

  // 3. Zero-cost local crop derived from Run 1's output.
  const cropped = (await app.execute('crop', { artifact_id: run1OutputId, left: 4, top: 4, width: 24, height: 16 })).artifact;

  // 4. Zero-cost pixel diff derived from both sourceA and cropped (diamond multi-parent!).
  const diff = (await app.execute('media.diff', { image_a_artifact_id: sourceA.id, image_b_artifact_id: cropped.id })).artifact;

  // 5. Run 2: downstream image-edit consuming the cropped artifact!
  const run2Draft = await app.execute('flow.create', { source_artifact_id: cropped.id, model_ref: FLOW_MODEL, prompt: 'refine crop' });
  const run2Id = run2Draft.run.id;
  await app.execute('flow.select', { run_id: run1Id, artifact_id: sourceA.id });
  const sibling = (await app.execute('flow.create', { source_artifact_id: sourceA.id, model_ref: FLOW_MODEL, prompt: 'edit the same original independently' })).run;

  // --- Pure Core module assertions ---
  const listed = listWorkspaceArtifacts(dataRoot, { kind: 'image', limit: 20, offset: 0 });
  assert(listed.total >= 5, 'expected at least 5 static images');
  const listedIds = new Set(listed.artifacts.map(item => item.artifactId));
  for (const id of [sourceA.id, sourceExif.id, run1OutputId, cropped.id, diff.id]) {
    assert(listedIds.has(id), 'listed workspace artifacts should include ' + id);
  }
  const paged = listWorkspaceArtifacts(dataRoot, { kind: 'image', limit: 2, offset: 0 });
  assert.equal(paged.artifacts.length, 2);
  assert.equal(paged.nextOffset, 2);

  // Artifact lineage on crop: parent is run1OutputId, child is diff, referencing run is run2Id.
  const cropLineage = inspectArtifactLineage(dataRoot, cropped.id);
  assert.equal(cropLineage.artifact.artifactId, cropped.id);
  assert.equal(cropLineage.artifact.kind, 'crop');
  assert.equal(cropLineage.totalParents, 1);
  assert.equal(cropLineage.parents[0].artifactId, run1OutputId);
  assert.equal(cropLineage.parents[0].relation, 'derived-from');
  assert.equal(cropLineage.totalChildren, 1);
  assert.equal(cropLineage.children[0].artifactId, diff.id);
  assert.equal(cropLineage.totalRuns, 1);
  assert.equal(cropLineage.runs[0].runId, run2Id);
  assert.deepEqual(cropLineage.runs[0].roles, ['source']);

  // Artifact lineage on diamond pixel-diff: two distinct derived-from parents!
  const diffLineage = inspectArtifactLineage(dataRoot, diff.id);
  assert.equal(diffLineage.totalParents, 2);
  assert.deepEqual(
    new Set(diffLineage.parents.map(p => p.artifactId)),
    new Set([sourceA.id, cropped.id])
  );

  // Run 1 lineage: directDerived includes cropped and diff; downstreamRuns includes run2Id!
  const run1Lineage = inspectRunLineage(dataRoot, run1Id);
  assert.equal(run1Lineage.runId, run1Id);
  assert(run1Lineage.directDerived.some(item => item.artifactId === cropped.id && item.relation === 'derived-from'));
  assert(run1Lineage.directDerived.some(item => item.artifactId === diff.id && item.relation === 'derived-from'));
  assert.equal(run1Lineage.totalDownstreamRuns, 1);
  assert.equal(run1Lineage.downstreamRuns[0].runId, run2Id);
  assert.equal(run1Lineage.totalUpstreamRuns, 0);
  assert.equal(inspectRunLineage(dataRoot, sibling.id).totalUpstreamRuns, 0, 'selecting a shared input does not make a Run its producer');

  // Run 2 lineage: upstreamArtifacts includes run1OutputId (via cropped), upstreamRuns includes run1Id!
  const run2Lineage = inspectRunLineage(dataRoot, run2Id);
  assert.equal(run2Lineage.runId, run2Id);
  assert.equal(run2Lineage.totalUpstreamArtifacts, 1);
  assert.equal(run2Lineage.upstreamArtifacts[0].artifactId, run1OutputId);
  assert.equal(run2Lineage.upstreamArtifacts[0].viaArtifactId, cropped.id);
  assert.equal(run2Lineage.totalUpstreamRuns, 1);
  assert.equal(run2Lineage.upstreamRuns[0].runId, run1Id);

  // --- HTTP API assertions (owner vs non-owner MCP connection, EXIF geometry, read-only guarantee) ---
  const before = tree();
  const pair = createConnectionPair({
    dataRoot,
    directory: path.join(root, 'mcp-pair'),
    origin: 'http://127.0.0.1:41999',
    label: 'Read+create MCP test client',
    scopes: ['read', 'create'],
    capabilities: ['image-edit', 'local-media'],
    tools: ['iris_core_runs', 'iris_core_run', 'iris_core_image', 'iris_core_crop', 'iris_core_pixel_diff']
  });
  const clientGrant = JSON.parse(fs.readFileSync(pair.clientFile, 'utf8'));

  const api = createLocalReadApi({ dataRoot, connectionsFile: pair.serverFile, allowLocalWrites: true });
  services.push(api);
  const session = await api.start();
  const ownerHeaders = { Authorization: 'Bearer ' + session.accessToken };
  const runtimeInstanceId = crypto.randomUUID();
  const handshake = await fetch(session.origin + '/api/v0/connections/' + pair.connectionId + '/handshake', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + clientGrant.accessToken,
      'Iris-Connection-Id': pair.connectionId,
      'Iris-Runtime-Id': runtimeInstanceId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contractVersion: 0,
      adapterId: pair.adapterId,
      harnessKind: pair.harnessKind,
      runtimeInstanceId,
      harnessVersion: '1.0.0',
      requestedScopes: ['read', 'create'],
      requestedCapabilities: ['image-edit', 'local-media'],
      requestedTools: ['iris_core_runs', 'iris_core_run', 'iris_core_image', 'iris_core_crop', 'iris_core_pixel_diff']
    })
  });
  assert.equal(handshake.status, 200);
  const connHeaders = {
    Authorization: 'Bearer ' + clientGrant.accessToken,
    'Iris-Connection-Id': pair.connectionId,
    'Iris-Runtime-Id': runtimeInstanceId
  };

  // Owner GET /api/v0/artifacts
  const listRes = await fetch(session.origin + '/api/v0/artifacts?kind=image&limit=10&offset=0', { headers: ownerHeaders });
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.equal(listJson.contractVersion, 0);
  assert(listJson.artifacts.some(item => item.artifactId === sourceExif.id));

  // Owner GET /api/v0/artifacts/:id/meta returns raw pixel geometry + EXIF orientation 6!
  const metaRes = await fetch(session.origin + '/api/v0/artifacts/' + sourceExif.id + '/meta', { headers: ownerHeaders });
  assert.equal(metaRes.status, 200);
  const metaJson = await metaRes.json();
  assert.equal(metaJson.contractVersion, 0);
  assert.equal(metaJson.artifactId, sourceExif.id);
  assert.deepEqual(metaJson.image, { width: 80, height: 40, orientation: 6 });

  // Owner GET /api/v0/artifacts/:id/lineage & /api/v0/runs/:id/lineage
  const artLinRes = await fetch(session.origin + '/api/v0/artifacts/' + cropped.id + '/lineage', { headers: ownerHeaders });
  assert.equal(artLinRes.status, 200);
  const artLinJson = await artLinRes.json();
  assert.equal(artLinJson.contractVersion, 0);
  assert.equal(artLinJson.parents[0].artifactId, run1OutputId);
  assert.equal(artLinJson.runs[0].runId, run2Id);

  const runLinRes = await fetch(session.origin + '/api/v0/runs/' + run2Id + '/lineage', { headers: ownerHeaders });
  assert.equal(runLinRes.status, 200);
  const runLinJson = await runLinRes.json();
  assert.equal(runLinJson.contractVersion, 0);
  assert.equal(runLinJson.upstreamRuns[0].runId, run1Id);

  // Invalid inputs & missing IDs
  assert.equal((await fetch(session.origin + '/api/v0/artifacts?kind=bad', { headers: ownerHeaders })).status, 400);
  assert.equal((await fetch(session.origin + '/api/v0/artifacts?limit=51', { headers: ownerHeaders })).status, 400);
  assert.equal((await fetch(session.origin + '/api/v0/artifacts?extra=1', { headers: ownerHeaders })).status, 400);
  assert.equal((await fetch(session.origin + '/api/v0/artifacts/not-an-id/meta', { headers: ownerHeaders })).status, 400);
  assert.equal((await fetch(session.origin + '/api/v0/artifacts/artifact_' + '0'.repeat(24) + '/lineage', { headers: ownerHeaders })).status, 404);
  assert.equal((await fetch(session.origin + '/api/v0/runs/run_' + '0'.repeat(24) + '/lineage', { headers: ownerHeaders })).status, 404);

  for (const route of [
    '/api/v0/artifacts',
    '/api/v0/artifacts/' + sourceExif.id + '/meta',
    '/api/v0/artifacts/' + cropped.id + '/lineage',
    '/api/v0/runs/' + run1Id + '/lineage'
  ]) {
    const url = session.origin + route;
    const head = await fetch(url, { method: 'HEAD', headers: ownerHeaders });
    assert.equal(head.status, 200, route);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const anonymous = await fetch(url);
    assert.equal(anonymous.status, 401, route);
    const crossOrigin = await fetch(url, { headers: { ...ownerHeaders, Origin: 'https://another-origin.invalid' } });
    assert.equal(crossOrigin.status, 403, route);
    assert.equal((await crossOrigin.json()).error.code, 'IRIS_API_ORIGIN_DENIED');
    const connection = await fetch(url, { headers: connHeaders });
    assert.equal(connection.status, 403, route);
    assert.equal((await connection.json()).error.code, 'IRIS_CONNECTION_CAPABILITY_DENIED');
  }

  assert.deepEqual(tree(), before, 'all artifact directory, meta and lineage reads must write zero Core bytes');
  console.log('core lineage: multi-hop provenance, EXIF-6 geometry, owner-only HTTP API, MCP 403 isolation and zero disk writes OK');
} finally {
  for (const service of services) await service.dispose();
  await app.dispose();
}
