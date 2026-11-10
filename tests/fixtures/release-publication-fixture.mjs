import fs from 'node:fs';
import path from 'node:path';
import { createReleaseManifest, MANIFEST_ASSET, INTENT_ASSET, ACCEPTED_ASSET } from '../../scripts/release-publication.mjs';

const ok = value => ({ status: 0, stdout: value === undefined ? '' : JSON.stringify(value), stderr: '' });
const error = code => ({ status: 1, stdout: JSON.stringify({ error: { code } }), stderr: 'npm error code ' + code });
export function executePublicationFixture(state, command, args, options = {}) {
  state.calls.push({ command, args, timeoutMs: options.timeoutMs, atMs: state.clockMs });
  state.clockMs += state.queryLatencyMs || 0;
  if (command === 'npm') {
    if (['ci', 'test'].includes(args[0])) return ok();
    if (args[0] === 'pack') return { status: 0, stdout: state.manifest.archive + '\n', stderr: '' };
    if (args[0] === 'publish') {
      state.publishAttempts++;
      if (state.accepted) return error('E409');
      if (state.failBeforeAccept) return error(state.failBeforeAccept);
      state.accepted = true; state.acceptedAtMs = state.clockMs; state.acceptedUploads++;
      if (state.failAfterAccept) return error(state.failAfterAccept);
      return ok();
    }
    if (args[0] === 'view') {
      if (state.registryError) return error(state.registryError);
      if (!state.accepted) return error('E404');
      if (args[2].startsWith('dist-tags.')) {
        if (state.clockMs >= state.acceptedAtMs + state.tagDelayMs) state.tags[state.manifest.distTag] = state.manifest.version;
        return ok(state.tags[state.manifest.distTag]);
      }
      if (state.clockMs < state.acceptedAtMs + state.versionDelayMs) return error('E404');
      return ok({ name: state.manifest.name, version: state.versionOverride || state.manifest.version,
        dist: { integrity: state.integrityOverride || state.manifest.integrity } });
    }
  }
  if (command === 'gh' && args[0] === 'release') {
    if (args[1] === 'list') return ok(state.release ? [{ tagName: state.manifest.gitTag }] : []);
    if (args[1] === 'create') {
      if (state.release) return error('E409');
      state.release = { tagName: state.manifest.gitTag, isDraft: args.includes('--draft'), isPrerelease: args.includes('--prerelease') };
      for (const file of args.filter(value => value.endsWith('.tgz') || path.basename(value) === MANIFEST_ASSET)) state.assets[path.basename(file)] = fs.readFileSync(file).toString('base64');
      return ok();
    }
    if (args[1] === 'view') return ok({ ...state.release, assets: Object.keys(state.assets).map(name => ({ name })) });
    if (args[1] === 'download') {
      const name = args[args.indexOf('--pattern') + 1], target = args[args.indexOf('--output') + 1];
      if (!state.assets[name]) return error('E404');
      fs.writeFileSync(target, Buffer.from(state.assets[name], 'base64')); return ok();
    }
    if (args[1] === 'upload') {
      const file = args[3], name = path.basename(file);
      if (!state.release.isDraft || state.assets[name]) return error('E403');
      if (state.failAsset === name) return error('E500');
      state.assets[name] = fs.readFileSync(file).toString('base64'); return ok();
    }
    if (args[1] === 'edit') {
      state.release.isDraft = false;
      if (args.includes('--latest=true')) state.githubLatest = state.manifest.gitTag;
      return ok();
    }
  }
  throw new Error('unexpected fixture command: ' + command + ' ' + args.join(' '));
}
export function createPublicationFixture(root, options = {}) {
  fs.mkdirSync(root);
  const version = options.version || '0.3.0-beta.2', packageJson = { name: '@fixture/iris', version };
  const archive = path.join(root, 'fixture-iris-' + version + '.tgz'), notes = path.join(root, 'notes.md');
  fs.writeFileSync(archive, 'controlled fixture archive ' + version); fs.writeFileSync(notes, 'fixture notes\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson));
  const manifest = createReleaseManifest({ archive, packageJson, tag: 'v' + version, commit: options.commit || 'a'.repeat(40) });
  const state = { manifest, calls: [], assets: {}, release: null, clockMs: 0, tags: { latest: '0.2.7', beta: '0.3.0-beta.1', rc: '0.3.0-rc.0', alpha: '0.3.0-alpha.1' },
    accepted: false, acceptedAtMs: 0, acceptedUploads: 0, publishAttempts: 0, versionDelayMs: 0, tagDelayMs: 0, ...options };
  return { root, archive, notes, manifest, state, options: { manifest, archive, notes, repo: 'fixture/iris', workDirectory: root,
    execute: (command, args, commandOptions) => executePublicationFixture(state, command, args, commandOptions) },
    verification: { execute: (command, args, commandOptions) => executePublicationFixture(state, command, args, commandOptions),
      now: () => state.clockMs, sleep: async ms => { state.clockMs += ms; state.sleeps = (state.sleeps || 0) + 1; } } };
}
export { MANIFEST_ASSET, INTENT_ASSET, ACCEPTED_ASSET };
