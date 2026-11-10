import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkedManifest, publishRelease, verifyPublication } from '../scripts/release-publication.mjs';
import { createPublicationFixture, INTENT_ASSET, ACCEPTED_ASSET } from './fixtures/release-publication-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-release-publication'), cases = [];
const setup = (name, options) => { cases.push(name); return createPublicationFixture(path.join(root, name), options); };
const rejects = (fn, code) => assert.rejects(fn, { code });
for (const version of ['0.3.0-beta.2', '0.3.0-rc.1', '0.3.0-alpha.2', '0.2.8']) {
  const f = setup('immediate-' + version, { version });
  assert.equal(f.manifest.integrity, 'sha512-' + createHash('sha512').update(fs.readFileSync(f.archive)).digest('base64'));
  assert.equal(publishRelease(f.options).state, 'accepted_pending_visibility');
  assert(f.state.assets[INTENT_ASSET] && f.state.assets[ACCEPTED_ASSET]);
  assert.equal(f.state.release.isDraft, false);
  assert.equal((await verifyPublication(f.manifest, f.verification)).state, 'confirmed');
  assert.equal(f.state.publishAttempts, 1);
  assert.equal(f.state.tags.latest, version.includes('-') ? '0.2.7' : version);
  assert.equal(publishRelease(f.options).state, 'already_published');
  assert.equal(f.state.publishAttempts, 1);
  assert(f.state.calls.filter(x => x.command === 'gh' && x.args[1] === 'upload').every(x => !x.args.includes('--clobber')));
}
for (const kind of ['version', 'tag']) {
  const f = setup('delay-' + kind, { [kind + 'DelayMs']: 240000 });
  publishRelease(f.options);
  assert.equal(publishRelease(f.options).state, kind === 'version' ? 'accepted_pending_visibility' : 'already_published');
  assert.equal(f.state.publishAttempts, 1, 'accepted receipt prevents upload while registry is still processing');
  const result = await verifyPublication(f.manifest, f.verification);
  assert.equal(result.elapsedMs, 240000); assert(result.attempts > 6);
  assert.equal(f.state.tags.latest, '0.2.7');
}
{
  const f = setup('timeout', { versionDelayMs: 1000000000 });
  publishRelease(f.options);
  await rejects(() => verifyPublication(f.manifest, f.verification), 'IRIS_RELEASE_CONFIRM_TIMEOUT');
  assert.equal(f.state.clockMs, 600000); assert.equal(f.state.publishAttempts, 1);
}
for (const code of ['E401', 'E403']) {
  const f = setup('auth-' + code, { registryError: code });
  await rejects(() => verifyPublication(f.manifest, f.verification), 'IRIS_RELEASE_REGISTRY_AUTH');
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.clockMs, 0);
}
{
  const f = setup('network', { registryError: 'ENOTFOUND' });
  await rejects(() => verifyPublication(f.manifest, { ...f.verification, timeoutMs: 30000 }), 'IRIS_RELEASE_CONFIRM_TIMEOUT');
  assert.equal(f.state.clockMs, 30000); assert.equal(f.state.sleeps, 3);
}
for (const [field, value] of [['versionOverride', '0.3.0-beta.999'], ['integrityOverride', 'sha512-' + 'a'.repeat(86) + '==']]) {
  const f = setup('mismatch-' + field); publishRelease(f.options); f.state[field] = value;
  await rejects(() => verifyPublication(f.manifest, f.verification), 'IRIS_RELEASE_PACKAGE_MISMATCH');
  assert.throws(() => publishRelease(f.options), { code: 'IRIS_RELEASE_PACKAGE_MISMATCH' });
  assert.equal(f.state.publishAttempts, 1); assert.equal(f.state.sleeps, undefined);
}
{
  const f = setup('wrong-channel', { tagDelayMs: 1000000000 });
  publishRelease(f.options);
  await rejects(() => verifyPublication(f.manifest, { ...f.verification, timeoutMs: 30000 }), 'IRIS_RELEASE_CONFIRM_TIMEOUT');
  assert.equal(f.state.tags.beta, '0.3.0-beta.1');
}
{
  const f = setup('lost-publish-result', { failAfterAccept: 'ECONNRESET', versionDelayMs: 240000 });
  assert.throws(() => publishRelease(f.options), { code: 'IRIS_RELEASE_PUBLISH_FAILED' });
  assert(f.state.assets[INTENT_ASSET]); assert.equal(f.state.assets[ACCEPTED_ASSET], undefined);
  assert.throws(() => publishRelease(f.options), { code: 'IRIS_RELEASE_SUBMISSION_UNKNOWN' });
  assert.equal(f.state.publishAttempts, 1); assert.equal(f.state.release.isDraft, true);
  f.state.clockMs = 250000;
  assert.equal(publishRelease(f.options).state, 'already_published');
  assert.equal(f.state.release.isDraft, false); assert.equal(f.state.publishAttempts, 1);
  const accepted = JSON.parse(Buffer.from(f.state.assets[ACCEPTED_ASSET], 'base64'));
  assert.equal(accepted.evidence, 'registry');
}
for (const asset of [INTENT_ASSET, ACCEPTED_ASSET]) {
  const f = setup('failed-' + asset, { failAsset: asset, versionDelayMs: 240000 });
  assert.throws(() => publishRelease(f.options), { code: 'IRIS_RELEASE_GITHUB_FAILED' });
  assert.equal(f.state.publishAttempts, asset === INTENT_ASSET ? 0 : 1);
  f.state.failAsset = null;
  if (asset === INTENT_ASSET) assert.equal(publishRelease(f.options).state, 'accepted_pending_visibility');
  else {
    assert.throws(() => publishRelease(f.options), { code: 'IRIS_RELEASE_SUBMISSION_UNKNOWN' });
    f.state.clockMs = 250000; assert.equal(publishRelease(f.options).state, 'already_published');
  }
  assert.equal(f.state.publishAttempts, 1);
}
{
  const f = setup('corrupt-receipt', { versionDelayMs: 240000 }); publishRelease(f.options);
  const receipt = JSON.parse(Buffer.from(f.state.assets[ACCEPTED_ASSET], 'base64'));
  receipt.manifest.commit = 'b'.repeat(40);
  f.state.assets[ACCEPTED_ASSET] = Buffer.from(JSON.stringify(receipt)).toString('base64');
  assert.throws(() => publishRelease(f.options), { code: 'IRIS_RELEASE_PACKAGE_MISMATCH' });
  assert.equal(f.state.publishAttempts, 1);
}
{
  const f = setup('corrupt-archive'); publishRelease(f.options);
  f.state.assets[f.manifest.archive] = Buffer.from('other bytes').toString('base64');
  assert.throws(() => publishRelease(f.options), { code: 'IRIS_RELEASE_PACKAGE_MISMATCH' });
  assert.equal(f.state.publishAttempts, 1);
}
{
  const f = setup('invalid-manifest');
  for (const patch of [{ schemaVersion: 2 }, { archive: '../escape.tgz' }, { distTag: 'latest' }, { commit: '' }]) {
    assert.throws(() => checkedManifest({ ...f.manifest, ...patch }));
  }
}
{
  const f = setup('rejected-upload', { failBeforeAccept: 'E403' });
  assert.throws(() => publishRelease(f.options), { code: 'IRIS_RELEASE_PUBLISH_FAILED' });
  assert.throws(() => publishRelease(f.options), { code: 'IRIS_RELEASE_SUBMISSION_UNKNOWN' });
  assert.equal(f.state.acceptedUploads, 0); assert.equal(f.state.publishAttempts, 1);
}
{
  const f = setup('late-channel-response'); publishRelease(f.options); f.state.queryLatencyMs = 6000;
  await rejects(() => verifyPublication(f.manifest, { ...f.verification, timeoutMs: 10000 }), 'IRIS_RELEASE_CONFIRM_TIMEOUT');
  const queries = f.state.calls.filter(call => call.command === 'npm' && call.args[0] === 'view');
  assert.equal(queries.at(-1).timeoutMs, 4000, 'channel query inherits remaining total budget');
}
{
  const f = setup('invalid-registry-json');
  await rejects(() => verifyPublication(f.manifest, { ...f.verification,
    execute: () => ({ status: 0, stdout: 'not JSON' }) }), 'IRIS_RELEASE_REGISTRY_RESPONSE_INVALID');
  assert.equal(f.state.clockMs, 0);
}
console.log('Release publication: ' + cases.length + ' controlled cases; independent confirmation, delayed visibility, bounded errors, immutable receipts/draft, unknown submissions and exact archive identity OK');
