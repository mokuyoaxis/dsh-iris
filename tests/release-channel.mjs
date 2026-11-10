import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releaseMetadata } from '../scripts/release-metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [version, tag] of [['0.2.8', 'latest'], ['0.3.0-alpha.1', 'alpha'], ['0.3.0-beta.2', 'beta'], ['0.3.0-rc.1', 'rc'], ['0.3.0+build-alpha', 'latest']]) {
  assert.deepEqual(releaseMetadata(version, 'v' + version), { npmTag: tag, prerelease: tag !== 'latest' });
}
for (const version of ['0.3.0-latest.1', '0.3.0-next.1', '0.3.0-1', '0.3.0-alpha.01', '0.3.0-alpha.1\nNPM_DIST_TAG=latest', 'bad']) {
  assert.throws(() => releaseMetadata(version, 'v' + version));
}
assert.throws(() => releaseMetadata('0.3.0-alpha.1', 'v0.2.7'));
const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const metadataCli = spawnSync(process.execPath, ['scripts/release-metadata.mjs', 'v' + current.version], { cwd: root, encoding: 'utf8', timeout: 15000 });
assert.ifError(metadataCli.error); assert.equal(metadataCli.status, 0, metadataCli.stderr);
const currentMetadata = releaseMetadata(current.version, 'v' + current.version);
assert.equal(metadataCli.stdout, `NPM_DIST_TAG=${currentMetadata.npmTag}\nRELEASE_PRERELEASE=${currentMetadata.prerelease}\n`);

const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const [publisher, confirmation] = workflow.split('\n  verify-publication:\n');
assert(confirmation, 'publication confirmation has its own rerunnable job');
assert(publisher.includes('manifest: ${{ steps.package.outputs.manifest }}'));
assert(confirmation.includes('needs: release'));
assert(confirmation.includes('RELEASE_MANIFEST_JSON: ${{ needs.release.outputs.manifest }}'));
assert(confirmation.includes('scripts/release-publication.mjs verify'));
assert(!/npm (?:ci|test|pack|publish)|secrets\.|contents: write|id-token: write/.test(confirmation), 'confirmation is read only and needs no publishing credential');
console.log('PASS release metadata and workflow: separate read-only confirmation; alpha/beta/rc preserve stable latest');
