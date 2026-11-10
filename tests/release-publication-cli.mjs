import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createPublicationFixture } from './fixtures/release-publication-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'win32' && fs.existsSync('/bin/bash')) {
  const { root } = useTempDshHome('iris-release-cli'), bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  // Node 22.1.0 needs an explicit module type for extensionless command shims.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const commandUrl = pathToFileURL(path.join(repo, 'tests/fixtures/release-publication-command.mjs')).href;
  for (const command of ['npm', 'gh']) fs.writeFileSync(path.join(bin, command),
    `#!/usr/bin/env node\nimport { runFixtureCommand } from ${JSON.stringify(commandUrl)};\nrunFixtureCommand(${JSON.stringify(command)}, process.argv.slice(2));\n`, { mode: 0o700 });
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/release.yml'), 'utf8');
  function step(name) {
    const start = workflow.indexOf('      - name: ' + name + '\n'); assert(start >= 0, name);
    const end = workflow.indexOf('\n      - ', start + 1), section = workflow.slice(start, end < 0 ? undefined : end);
    const at = section.indexOf('        run: |\n'); assert(at >= 0, name);
    return section.slice(at + '        run: |\n'.length).split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
  }
  for (const version of ['0.3.0-beta.2', '0.3.0-rc.1', '0.2.8']) {
    const f = createPublicationFixture(path.join(root, version), { version });
    fs.mkdirSync(path.join(f.root, 'scripts'));
    fs.symlinkSync(path.join(repo, 'lib'), path.join(f.root, 'lib'), 'dir');
    for (const name of ['release-publication.mjs', 'release-metadata.mjs']) fs.copyFileSync(path.join(repo, 'scripts', name), path.join(f.root, 'scripts', name));
    const stateFile = path.join(f.root, 'registry.json'); fs.writeFileSync(stateFile, JSON.stringify(f.state));
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, NODE_OPTIONS: '',
      IRIS_RELEASE_FIXTURE: stateFile, IRIS_RELEASE_COMMIT: f.manifest.commit,
      GITHUB_REF_NAME: f.manifest.gitTag, GITHUB_REPOSITORY: 'fixture/iris', TARBALL: f.archive,
      RUNNER_TEMP: f.root, GITHUB_ENV: path.join(f.root, 'github-env'), GITHUB_OUTPUT: path.join(f.root, 'github-output'),
      GH_TOKEN: '', NODE_AUTH_TOKEN: '', NPM_TOKEN: '' };
    function run(script) {
      const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], { cwd: f.root, env, encoding: 'utf8', timeout: 30000 });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    // Only Git's local commit lookup and external gh/npm commands are replaced.
    // The actual workflow shell and prepare/publish/verify CLIs run unchanged.
    run('git() { test "$*" = "rev-parse HEAD"; printf "%s\\n" "$IRIS_RELEASE_COMMIT"; }\n' + step('Bind the release archive'));
    const manifestFile = path.join(f.root, 'iris-release-package.json');
    const output = fs.readFileSync(env.GITHUB_OUTPUT, 'utf8').trim(); assert(output.startsWith('manifest='));
    assert.deepEqual(JSON.parse(output.slice(9)), f.manifest);
    env.RELEASE_MANIFEST = manifestFile;
    // Avoid writing workflow notes into the host's shared /tmp path.
    env.IRIS_RELEASE_NOTES = f.notes;
    run(step('Publish with an immutable upload receipt').replace('/tmp/release-notes.md', '"$IRIS_RELEASE_NOTES"'));
    env.RELEASE_MANIFEST_JSON = output.slice(9);
    run(step('Verify npm publication'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'npm-verification.json'))).state, 'confirmed');
    const state = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(state.publishAttempts, 1);
    assert.equal(state.tags.latest, f.manifest.distTag === 'latest' ? version : '0.2.7');
    const before = state.calls.length;
    run(step('Verify npm publication').replace('npm-verification.json', 'npm-verification-retry.json'));
    const retried = JSON.parse(fs.readFileSync(stateFile));
    assert(retried.calls.slice(before).every(call => call.command === 'npm' && call.args[0] === 'view'));
  }
  console.log('PASS actual release shell and CLI integration: beta/rc/stable, job-output identity, receipts, read-only confirmation rerun; all remote commands mocked');
} else console.log('SKIP POSIX release shell/command shim integration; platform-independent publication cases run separately');
